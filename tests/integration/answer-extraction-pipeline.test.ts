import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setAssessmentStore } from '@/lib/services/assessment-store';
import { LocalDocumentStorage, setDocumentStorage } from '@/lib/storage/local-storage';
import {
  createAssessment,
  getAssessment,
  markStageCompleted,
} from '@/lib/services/assessment-service';
import { uploadDocument } from '@/lib/services/document/document-service';
import { runAssessmentPipeline } from '@/lib/services/pipeline/runner';
import { STAGE_HANDLERS } from '@/lib/services/pipeline/stages';
import { FakeAIProvider, setAIProvider } from '@/lib/providers/ai';
import { FakeEmbeddingProvider, setEmbeddingProvider } from '@/lib/providers/embeddings';
import { DependencyUnavailableError } from '@/lib/errors';
import { JOB_NAMES, buildJobOptions, type AssessmentJobData } from '@/lib/queue/jobs';
import { A4_PORTRAIT, makePdf } from '../fixtures/documents';
import type {
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
} from '@/lib/providers/ai';

/**
 * Phase 4 integration: answer extraction as a stage of the existing pipeline,
 * against real Redis state and a real BullMQ worker.
 *
 * No real model is contacted — a scripted provider stands in, so the suite
 * needs no API key and cannot be broken by Gemini availability.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_QUEUE = 'assessment-processing-phase4-test';

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  });

  try {
    await probe.connect();
    return (await probe.ping()) === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();

if (!available) {
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — Phase 4 integration tests skipped.`);
}

const QUESTIONS: ExtractedQuestionCandidate[] = [
  {
    labelRaw: 'Q1',
    text: 'Which organelle is primarily involved in photosynthesis?',
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.75, height: 0.06 }],
  },
];

/**
 * Deliberately awkward: written out of order, one unlabelled, one spanning
 * two pages, one with a diagram, and two claiming the same label.
 */
const ANSWERS: ExtractedAnswerCandidate[] = [
  {
    claimedLabelRaw: 'Q3',
    text: 'Written first on the sheet even though it claims question 3.',
    regions: [{ pageNumber: 1, x: 0.08, y: 0.1, width: 0.82, height: 0.12, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: 'The process mainly occurs in the chloroplast of the plant cell.',
    regions: [{ pageNumber: 1, x: 0.08, y: 0.3, width: 0.82, height: 0.14, kind: 'text' }],
  },
  {
    claimedLabelRaw: 'Q2',
    text: 'Sunlight enters the leaf. [diagram: plant with labelled arrows]',
    regions: [
      { pageNumber: 1, x: 0.08, y: 0.5, width: 0.8, height: 0.06, kind: 'text' },
      { pageNumber: 1, x: 0.2, y: 0.58, width: 0.55, height: 0.3, kind: 'diagram' },
    ],
  },
  {
    claimedLabelRaw: 'Q2',
    text: 'A second block also labelled Q2, further down the sheet.',
    regions: [{ pageNumber: 2, x: 0.08, y: 0.45, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: 'Q4',
    text: 'First half of the answer, continued on the next page.',
    regions: [
      { pageNumber: 1, x: 0.08, y: 0.9, width: 0.8, height: 0.08, kind: 'text' },
      { pageNumber: 2, x: 0.08, y: 0.05, width: 0.8, height: 0.2, kind: 'text' },
    ],
  },
];

let storageRoot: string;
const createdAssessments: string[] = [];
const fakeAI = new FakeAIProvider({ candidates: QUESTIONS, answerCandidates: ANSWERS });

async function seedAssessment(): Promise<string> {
  const assessment = await createAssessment({ title: 'phase 4 integration' });
  createdAssessments.push(assessment.id);

  await uploadDocument({
    assessmentId: assessment.id,
    type: 'QUESTION_PAPER',
    filename: 'paper.pdf',
    declaredMimeType: 'application/pdf',
    data: makePdf([A4_PORTRAIT]),
  });

  await uploadDocument({
    assessmentId: assessment.id,
    type: 'ANSWER_SHEET',
    filename: 'answers.pdf',
    declaredMimeType: 'application/pdf',
    data: makePdf([A4_PORTRAIT, A4_PORTRAIT]),
  });

  return assessment.id;
}

describe.skipIf(!available)('EXTRACTING_ANSWERS through the pipeline', () => {
  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot = await mkdtemp(join(tmpdir(), 'veda-phase4-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(new FakeEmbeddingProvider());
  });

  beforeEach(() => {
    fakeAI.reset();
    fakeAI.configure({ candidates: QUESTIONS, answerCandidates: ANSWERS });
  });

  afterAll(async () => {
    setAIProvider(null);
    setEmbeddingProvider(null);
    setDocumentStorage(null);
    await rm(storageRoot, { recursive: true, force: true });

    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    for (const id of createdAssessments) {
      await redis.del(`veda-test:assessment:${id}`).catch(() => undefined);
    }
    await redis.quit().catch(() => redis.disconnect());
  });

  it('extracts and persists answers after questions', async () => {
    const assessmentId = await seedAssessment();
    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p4-1' });

    expect(outcome.executedStages.slice(0, 3)).toEqual([
      'PREPARING',
      'EXTRACTING_QUESTIONS',
      'EXTRACTING_ANSWERS',
    ]);

    const stored = await getAssessment(assessmentId);

    expect(stored.status).toBe('COMPLETED');
    expect(stored.answers).toHaveLength(5);
    expect(fakeAI.extractAnswersCalls).toBe(1);
  });

  it('orders answers by position on the sheet, not by claimed label', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-2' });

    const stored = await getAssessment(assessmentId);

    // Q3 is written first; ordering reflects the page, never the label.
    expect(stored.answers.map((a) => a.claimedLabelRaw)).toEqual([
      'Q3',
      null,
      'Q2',
      'Q4',
      'Q2',
    ]);
    expect(stored.answers.map((a) => a.documentPosition)).toEqual([0, 1, 2, 3, 4]);
  });

  it('keeps the unlabelled answer rather than discarding it', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-3' });

    const stored = await getAssessment(assessmentId);
    const unlabelled = stored.answers.filter((a) => a.claimedLabelRaw === null);

    expect(unlabelled).toHaveLength(1);
    expect(unlabelled[0]!.text).toContain('chloroplast');
    expect(stored.answerExtraction?.unlabelledCount).toBe(1);
  });

  it('represents a spanning answer as one answer on two pages', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-4' });

    const stored = await getAssessment(assessmentId);
    const spanning = stored.answers.filter((a) => a.spansPages);

    expect(spanning).toHaveLength(1);
    expect(spanning[0]!.claimedLabelRaw).toBe('Q4');
    expect(spanning[0]!.pageNumbers).toEqual([1, 2]);
    expect(spanning[0]!.regions).toHaveLength(2);
  });

  it('keeps a multi-region answer with its diagram', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-5' });

    const stored = await getAssessment(assessmentId);
    const withDiagram = stored.answers.find((a) => a.containsDiagram);

    expect(withDiagram?.regions).toHaveLength(2);
    expect(withDiagram?.regions.map((r) => r.kind)).toEqual(['text', 'diagram']);
  });

  it('keeps both answers claiming the same label and reports the clash', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-6' });

    const stored = await getAssessment(assessmentId);

    expect(stored.answers.filter((a) => a.claimedLabelNormalized === '2')).toHaveLength(2);
    expect(
      stored.answerExtraction?.warnings.some((w) => w.code === 'DUPLICATE_CLAIMED_LABEL'),
    ).toBe(true);
  });

  it('stores normalized coordinates bound to their page', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-7' });

    const stored = await getAssessment(assessmentId);

    for (const answer of stored.answers) {
      expect(answer.regions.length).toBeGreaterThan(0);

      for (const region of answer.regions) {
        expect(region.x).toBeGreaterThanOrEqual(0);
        expect(region.y).toBeGreaterThanOrEqual(0);
        expect(region.x + region.width).toBeLessThanOrEqual(1);
        expect(region.y + region.height).toBeLessThanOrEqual(1);
        expect([1, 2]).toContain(region.pageNumber);
      }
    }
  });

  it('sends the canonical prepared pages of the answer sheet', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-8' });

    const stored = await getAssessment(assessmentId);
    const sheet = stored.documents.find((d) => d.type === 'ANSWER_SHEET')!;

    expect(fakeAI.lastAnswerPages).toHaveLength(sheet.pages.length);

    for (const [index, page] of fakeAI.lastAnswerPages.entries()) {
      const prepared = sheet.pages[index]!;
      expect(page.pageNumber).toBe(prepared.pageNumber);
      expect(page.width).toBe(prepared.width);
      expect(page.height).toBe(prepared.height);
    }
  });

  it('makes no mapping decision, even where a label matches exactly', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p4-9' });

    const stored = await getAssessment(assessmentId);

    // Q1 exists as a question; nothing links any answer to it.
    expect(stored.questions).toHaveLength(1);
    expect(JSON.stringify(stored.answers)).not.toContain(stored.questions[0]!.id);

    for (const answer of stored.answers) {
      expect(answer as unknown as Record<string, unknown>).not.toHaveProperty('questionId');
    }
  });

  it('does not call the model when the sheet was never prepared', async () => {
    const assessmentId = await seedAssessment();
    await markStageCompleted(assessmentId, 'PREPARING');

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'p4-10' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(fakeAI.extractAnswersCalls).toBe(0);
    expect((await getAssessment(assessmentId)).answers).toEqual([]);
  });

  it('skips extraction when the stage record already shows it complete', async () => {
    const assessmentId = await seedAssessment();

    await runAssessmentPipeline({ assessmentId, jobId: 'p4-11' });
    expect(fakeAI.extractAnswersCalls).toBe(1);

    fakeAI.reset();
    const replay = await runAssessmentPipeline({ assessmentId, jobId: 'p4-11' });

    expect(replay.skippedStages).toContain('EXTRACTING_ANSWERS');
    expect(fakeAI.extractAnswersCalls).toBe(0);
    expect((await getAssessment(assessmentId)).answers).toHaveLength(5);
  });

  it('resumes without re-extracting when a later stage fails and retries', async () => {
    const assessmentId = await seedAssessment();
    const original = STAGE_HANDLERS[JOB_NAMES.MAP_ANSWERS];
    let attempts = 0;

    STAGE_HANDLERS[JOB_NAMES.MAP_ANSWERS] = async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient downstream failure');
    };

    try {
      await expect(
        runAssessmentPipeline({ assessmentId, jobId: 'p4-12' }),
      ).rejects.toThrow('transient downstream failure');

      expect(fakeAI.extractAnswersCalls).toBe(1);

      const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p4-12' });

      expect(outcome.skippedStages).toContain('EXTRACTING_ANSWERS');
      expect(fakeAI.extractAnswersCalls).toBe(1);
      expect((await getAssessment(assessmentId)).answers).toHaveLength(5);
    } finally {
      STAGE_HANDLERS[JOB_NAMES.MAP_ANSWERS] = original!;
    }
  });

  it('propagates a transient model failure for the queue to retry', async () => {
    const assessmentId = await seedAssessment();
    fakeAI.configure({
      candidates: QUESTIONS,
      answerError: new DependencyUnavailableError('Gemini rate limit exceeded.'),
    });

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'p4-13' }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });

    const stored = await getAssessment(assessmentId);

    expect(stored.stage).toBe('EXTRACTING_ANSWERS');
    expect(stored.answers).toEqual([]);
    // Questions still stand, so the retry will not redo them.
    expect(stored.questions).toHaveLength(1);
    expect(stored.completedStages.map((r) => r.stage)).toContain('EXTRACTING_QUESTIONS');
  });

  it('succeeds on retry once the model recovers, without re-extracting questions', async () => {
    const assessmentId = await seedAssessment();
    fakeAI.configure({
      candidates: QUESTIONS,
      answerError: new DependencyUnavailableError('temporary outage'),
    });

    await expect(runAssessmentPipeline({ assessmentId, jobId: 'p4-14' })).rejects.toThrow();
    expect(fakeAI.extractQuestionsCalls).toBe(1);

    fakeAI.configure({ candidates: QUESTIONS, answerCandidates: ANSWERS });
    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p4-14' });

    expect(outcome.skippedStages).toContain('EXTRACTING_QUESTIONS');
    expect(outcome.executedStages).toContain('EXTRACTING_ANSWERS');
    expect(fakeAI.extractQuestionsCalls).toBe(1);
    expect((await getAssessment(assessmentId)).answers).toHaveLength(5);
  });
});

describe.skipIf(!available)('EXTRACTING_ANSWERS through a real BullMQ worker', () => {
  let queue: Queue<AssessmentJobData>;
  let queueConnection: Redis;
  let worker: Worker<AssessmentJobData> | null = null;

  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot ??= await mkdtemp(join(tmpdir(), 'veda-phase4-queue-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(new FakeEmbeddingProvider());

    queueConnection = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    queue = new Queue<AssessmentJobData>(TEST_QUEUE, { connection: queueConnection });
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterEach(async () => {
    if (worker) {
      await worker.close();
      worker = null;
    }
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    setAIProvider(null);
    setEmbeddingProvider(null);
    await queue.close();
    await queueConnection.quit().catch(() => queueConnection.disconnect());
  });

  it('retries a transient model failure and extracts on a later attempt', async () => {
    fakeAI.reset();

    let attempts = 0;
    fakeAI.configure({
      candidates: QUESTIONS,
      answerCandidates: ANSWERS,
      onExtractAnswers: () => {
        attempts += 1;
        if (attempts < 2) throw new DependencyUnavailableError('rate limited');
      },
    });

    const assessmentId = await seedAssessment();

    worker = new Worker<AssessmentJobData>(
      TEST_QUEUE,
      async (job) => {
        await runAssessmentPipeline(job.data);
      },
      { connection: new Redis(REDIS_URL, { maxRetriesPerRequest: null }), concurrency: 1 },
    );

    const completed = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('timed out')), 25_000);
      worker!.once('completed', () => {
        clearTimeout(timer);
        resolve();
      });
    });

    const jobId = 'queue-answers-1';
    await queue.add(JOB_NAMES.PREPARE, { assessmentId, jobId }, buildJobOptions({ jobId }));
    await completed;

    const stored = await getAssessment(assessmentId);

    expect(attempts).toBe(2);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.answers).toHaveLength(5);
    // The second attempt skipped preparation and question extraction.
    expect(fakeAI.extractQuestionsCalls).toBe(1);

    fakeAI.configure({ candidates: QUESTIONS, answerCandidates: ANSWERS });
  }, 40_000);
});
