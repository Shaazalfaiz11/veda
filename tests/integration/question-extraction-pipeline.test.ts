import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setAssessmentStore } from '@/lib/services/assessment-store';
import { LocalDocumentStorage, setDocumentStorage } from '@/lib/storage/local-storage';
import { createAssessment, getAssessment, markStageCompleted } from '@/lib/services/assessment-service';
import { uploadDocument } from '@/lib/services/document/document-service';
import { runAssessmentPipeline } from '@/lib/services/pipeline/runner';
import { STAGE_HANDLERS } from '@/lib/services/pipeline/stages';
import { FakeAIProvider, setAIProvider } from '@/lib/providers/ai';
import { FakeEmbeddingProvider, setEmbeddingProvider } from '@/lib/providers/embeddings';
import { DependencyUnavailableError } from '@/lib/errors';
import { JOB_NAMES, buildJobOptions, type AssessmentJobData } from '@/lib/queue/jobs';
import { A4_PORTRAIT, makePdf, makePng } from '../fixtures/documents';
import type {
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
} from '@/lib/providers/ai';

/**
 * Phase 3 integration: question extraction as a stage of the existing
 * pipeline, against real Redis state and a real BullMQ worker.
 *
 * No real model is ever contacted — a scripted provider stands in, so the
 * suite needs no API key and cannot be broken by Gemini availability.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_QUEUE = 'assessment-processing-phase3-test';

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
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — Phase 3 integration tests skipped.`);
}

const CANDIDATES: ExtractedQuestionCandidate[] = [
  {
    labelRaw: 'Q2',
    text: 'Describe the flow of blood through the human heart.',
    marks: 4,
    pageNumber: 2,
    rects: [{ pageNumber: 2, x: 0.1, y: 0.15, width: 0.78, height: 0.09 }],
  },
  {
    labelRaw: 'Q1',
    text: 'Which organelle is primarily involved in photosynthesis?',
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.22, width: 0.75, height: 0.06 }],
  },
  {
    labelRaw: '1 (a)',
    text: 'Name the pigment it contains.',
    marks: null,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.12, y: 0.3, width: 0.7, height: 0.05 }],
  },
];

/**
 * A full pipeline run now reaches EXTRACTING_ANSWERS too, so the scripted
 * provider has to answer both calls. Answer extraction has its own suite;
 * these are the minimum candidates that let the pipeline complete.
 */
const ANSWER_CANDIDATES: ExtractedAnswerCandidate[] = [
  {
    claimedLabelRaw: 'Q1',
    text: 'The chloroplast.',
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.05, kind: 'text' }],
  },
];

let storageRoot: string;
const createdAssessments: string[] = [];
const fakeAI = new FakeAIProvider({
  candidates: CANDIDATES,
  answerCandidates: ANSWER_CANDIDATES,
});

async function seedAssessment(): Promise<string> {
  const assessment = await createAssessment({ title: 'phase 3 integration' });
  createdAssessments.push(assessment.id);

  await uploadDocument({
    assessmentId: assessment.id,
    type: 'QUESTION_PAPER',
    filename: 'paper.pdf',
    declaredMimeType: 'application/pdf',
    data: makePdf([A4_PORTRAIT, A4_PORTRAIT]),
  });

  await uploadDocument({
    assessmentId: assessment.id,
    type: 'ANSWER_SHEET',
    filename: 'answers.png',
    declaredMimeType: 'image/png',
    data: await makePng(600, 800),
  });

  return assessment.id;
}

describe.skipIf(!available)('EXTRACTING_QUESTIONS through the pipeline', () => {
  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot = await mkdtemp(join(tmpdir(), 'veda-phase3-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(new FakeEmbeddingProvider());
  });

  beforeEach(() => {
    fakeAI.reset();
    fakeAI.configure({ candidates: CANDIDATES, answerCandidates: ANSWER_CANDIDATES });
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

  it('extracts and persists questions after preparation', async () => {
    const assessmentId = await seedAssessment();
    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p3-1' });

    expect(outcome.executedStages.slice(0, 2)).toEqual(['PREPARING', 'EXTRACTING_QUESTIONS']);

    const stored = await getAssessment(assessmentId);

    expect(stored.status).toBe('COMPLETED');
    expect(stored.questions).toHaveLength(3);
    expect(fakeAI.extractQuestionsCalls).toBe(1);
  });

  it('orders questions deterministically, not by model output order', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p3-2' });

    const stored = await getAssessment(assessmentId);
    expect(stored.questions.map((question) => question.labelRaw)).toEqual([
      'Q1',
      '1 (a)',
      'Q2',
    ]);
  });

  it('stores normalized coordinates bound to their page', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p3-3' });

    const stored = await getAssessment(assessmentId);

    for (const question of stored.questions) {
      expect(question.rects.length).toBeGreaterThan(0);

      for (const rect of question.rects) {
        expect(rect.x).toBeGreaterThanOrEqual(0);
        expect(rect.x).toBeLessThanOrEqual(1);
        expect(rect.y).toBeGreaterThanOrEqual(0);
        expect(rect.y).toBeLessThanOrEqual(1);
        expect(rect.x + rect.width).toBeLessThanOrEqual(1);
        expect(rect.y + rect.height).toBeLessThanOrEqual(1);
        expect([1, 2]).toContain(rect.pageNumber);
      }
    }
  });

  it('records provenance for the run', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p3-4' });

    const stored = await getAssessment(assessmentId);

    expect(stored.questionExtraction).toMatchObject({
      provider: 'fake',
      promptVersion: 'question-extraction/v2',
      pagesProcessed: 2,
      questionsExtracted: 3,
    });
  });

  it('sends the canonical prepared pages, not a re-render', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p3-5' });

    const stored = await getAssessment(assessmentId);
    const document = stored.documents[0]!;

    expect(fakeAI.lastPages).toHaveLength(document.pages.length);

    for (const [index, page] of fakeAI.lastPages.entries()) {
      const prepared = document.pages[index]!;
      expect(page.pageNumber).toBe(prepared.pageNumber);
      expect(page.width).toBe(prepared.width);
      expect(page.height).toBe(prepared.height);
    }
  });

  it('does not call the model when the paper was never prepared', async () => {
    const assessmentId = await seedAssessment();
    await markStageCompleted(assessmentId, 'PREPARING');

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'p3-6' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect(fakeAI.extractQuestionsCalls).toBe(0);
    expect((await getAssessment(assessmentId)).questions).toEqual([]);
  });

  it('skips extraction when the stage record already shows it complete', async () => {
    const assessmentId = await seedAssessment();

    await runAssessmentPipeline({ assessmentId, jobId: 'p3-7' });
    expect(fakeAI.extractQuestionsCalls).toBe(1);

    // Re-running the same job replays the pipeline; both idempotency layers
    // must hold, so the model is not called a second time.
    fakeAI.reset();
    const replay = await runAssessmentPipeline({ assessmentId, jobId: 'p3-7' });

    expect(replay.skippedStages).toContain('EXTRACTING_QUESTIONS');
    expect(fakeAI.extractQuestionsCalls).toBe(0);

    // Replaying a finished run stays COMPLETED rather than conflicting.
    const stored = await getAssessment(assessmentId);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.questions).toHaveLength(3);
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
        runAssessmentPipeline({ assessmentId, jobId: 'p3-8' }),
      ).rejects.toThrow('transient downstream failure');

      expect(fakeAI.extractQuestionsCalls).toBe(1);

      const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p3-8' });

      expect(outcome.skippedStages).toContain('EXTRACTING_QUESTIONS');
      // Still one call in total across both attempts.
      expect(fakeAI.extractQuestionsCalls).toBe(1);

      const stored = await getAssessment(assessmentId);
      expect(stored.status).toBe('COMPLETED');
      expect(stored.questions).toHaveLength(3);
    } finally {
      STAGE_HANDLERS[JOB_NAMES.MAP_ANSWERS] = original!;
    }
  });

  it('propagates a transient model failure for the queue to retry', async () => {
    const assessmentId = await seedAssessment();
    fakeAI.configure({
      answerCandidates: ANSWER_CANDIDATES,
      error: new DependencyUnavailableError('Gemini rate limit exceeded.'),
    });

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'p3-9' }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });

    const stored = await getAssessment(assessmentId);

    expect(stored.stage).toBe('EXTRACTING_QUESTIONS');
    expect(stored.questions).toEqual([]);
    // Preparation still stands, so the retry will not redo it.
    expect(stored.documents[0]!.status).toBe('READY');
    expect(stored.completedStages.map((record) => record.stage)).toContain('PREPARING');
  });

  it('succeeds on retry once the model recovers, without re-preparing', async () => {
    const assessmentId = await seedAssessment();
    fakeAI.configure({
      answerCandidates: ANSWER_CANDIDATES,
      error: new DependencyUnavailableError('temporary outage'),
    });

    await expect(runAssessmentPipeline({ assessmentId, jobId: 'p3-10' })).rejects.toThrow();

    fakeAI.configure({ candidates: CANDIDATES, answerCandidates: ANSWER_CANDIDATES });
    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p3-10' });

    expect(outcome.skippedStages).toContain('PREPARING');
    expect(outcome.executedStages).toContain('EXTRACTING_QUESTIONS');
    expect((await getAssessment(assessmentId)).questions).toHaveLength(3);
  });
});

describe.skipIf(!available)('EXTRACTING_QUESTIONS through a real BullMQ worker', () => {
  let queue: Queue<AssessmentJobData>;
  let queueConnection: Redis;
  let worker: Worker<AssessmentJobData> | null = null;

  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot ??= await mkdtemp(join(tmpdir(), 'veda-phase3-queue-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(new FakeEmbeddingProvider());
    fakeAI.configure({ candidates: CANDIDATES, answerCandidates: ANSWER_CANDIDATES });

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
      candidates: CANDIDATES,
      answerCandidates: ANSWER_CANDIDATES,
      onExtractQuestions: () => {
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

    const jobId = 'queue-extract-1';
    await queue.add(JOB_NAMES.PREPARE, { assessmentId, jobId }, buildJobOptions({ jobId }));
    await completed;

    const stored = await getAssessment(assessmentId);

    expect(attempts).toBe(2);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.questions).toHaveLength(3);
    // The second attempt skipped preparation and only redid extraction.
    expect(stored.documents[0]!.status).toBe('READY');

    fakeAI.configure({ candidates: CANDIDATES, answerCandidates: ANSWER_CANDIDATES });
  }, 40_000);
});
