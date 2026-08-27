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
 * Phase 5 integration: mapping as a stage of the existing pipeline, against
 * real Redis state and a real BullMQ worker.
 *
 * No real model or embedding API is contacted — scripted providers stand in,
 * so the suite needs no API key and cannot be broken by provider availability.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_QUEUE = 'assessment-processing-phase5-test';

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
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — Phase 5 integration tests skipped.`);
}

const PHOTOSYNTHESIS_Q = 'Which organelle is primarily involved in photosynthesis?';
const HEART_Q = 'Describe the flow of blood through the human heart.';
const OSMOSIS_Q = 'Define osmosis and give one example.';

const CHLOROPLAST_A = 'The chloroplast is the organelle responsible for photosynthesis.';
const HEART_A = 'Blood enters the right atrium and passes into the right ventricle.';
const UNRELATED_A = 'Levers and pulleys are examples of simple machines.';

const QUESTIONS: ExtractedQuestionCandidate[] = [
  {
    labelRaw: 'Q1',
    text: PHOTOSYNTHESIS_Q,
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.15, width: 0.75, height: 0.06 }],
  },
  {
    labelRaw: 'Q2',
    text: HEART_Q,
    marks: 4,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.3, width: 0.75, height: 0.06 }],
  },
  {
    labelRaw: 'Q3',
    text: OSMOSIS_Q,
    marks: 3,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.45, width: 0.75, height: 0.06 }],
  },
];

/** Written out of order, one unlabelled, one that answers nothing on the paper. */
const ANSWERS: ExtractedAnswerCandidate[] = [
  {
    claimedLabelRaw: 'Q2',
    text: HEART_A,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.1, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: CHLOROPLAST_A,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.35, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: UNRELATED_A,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.6, width: 0.8, height: 0.1, kind: 'text' }],
  },
];

/** Scripted so semantic discrimination is deterministic and explicit. */
function embeddings() {
  return new FakeEmbeddingProvider({
    dimensions: 4,
    vectors: {
      [PHOTOSYNTHESIS_Q]: [1, 0, 0, 0.1],
      [CHLOROPLAST_A]: [0.97, 0.05, 0, 0.1],
      [HEART_Q]: [0, 1, 0, 0.1],
      [HEART_A]: [0.05, 0.97, 0, 0.1],
      [OSMOSIS_Q]: [0, 0, 1, 0.1],
      [UNRELATED_A]: [0.05, 0.05, 0.05, 1],
    },
  });
}

let storageRoot: string;
const createdAssessments: string[] = [];
const fakeAI = new FakeAIProvider({ candidates: QUESTIONS, answerCandidates: ANSWERS });

async function seedAssessment(): Promise<string> {
  const assessment = await createAssessment({ title: 'phase 5 integration' });
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
    data: makePdf([A4_PORTRAIT]),
  });

  return assessment.id;
}

describe.skipIf(!available)('MAPPING through the pipeline', () => {
  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot = await mkdtemp(join(tmpdir(), 'veda-phase5-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(embeddings());
  });

  beforeEach(() => {
    fakeAI.reset();
    fakeAI.configure({ candidates: QUESTIONS, answerCandidates: ANSWERS });
    setEmbeddingProvider(embeddings());
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

  it('runs MAPPING after answer extraction and persists mappings', async () => {
    const assessmentId = await seedAssessment();
    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p5-1' });

    expect(outcome.executedStages.slice(0, 4)).toEqual([
      'PREPARING',
      'EXTRACTING_QUESTIONS',
      'EXTRACTING_ANSWERS',
      'MAPPING',
    ]);

    const stored = await getAssessment(assessmentId);

    expect(stored.status).toBe('COMPLETED');
    expect(stored.mappings).toHaveLength(3);
    expect(stored.mapping).not.toBeNull();
  });

  it('maps a labelled answer to its question', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p5-2' });

    const stored = await getAssessment(assessmentId);
    const heartQuestion = stored.questions.find((q) => q.labelRaw === 'Q2')!;
    const heartAnswer = stored.answers.find((a) => a.claimedLabelRaw === 'Q2')!;

    const mapping = stored.mappings.find((m) => m.answerId === heartAnswer.id)!;
    expect(mapping.questionId).toBe(heartQuestion.id);
    expect(mapping.reasonCodes).toContain('DIRECT_LABEL_MATCH');
  });

  it('maps an unlabelled answer on semantics', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p5-3' });

    const stored = await getAssessment(assessmentId);
    const photosynthesisQuestion = stored.questions.find((q) => q.labelRaw === 'Q1')!;
    const chloroplastAnswer = stored.answers.find((a) => a.text === CHLOROPLAST_A)!;

    const mapping = stored.mappings.find((m) => m.answerId === chloroplastAnswer.id)!;
    expect(mapping.questionId).toBe(photosynthesisQuestion.id);
    expect(mapping.signals?.labelKind).toBe('NO_LABEL');
  });

  it('never assigns one question to two answers', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p5-4' });

    const stored = await getAssessment(assessmentId);
    const assigned = stored.mappings
      .map((m) => m.questionId)
      .filter((id): id is string => id !== null);

    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('leaves the unrelated answer unmapped rather than forcing it', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p5-5' });

    const stored = await getAssessment(assessmentId);
    const unrelated = stored.answers.find((a) => a.text === UNRELATED_A)!;
    const mapping = stored.mappings.find((m) => m.answerId === unrelated.id)!;

    expect(mapping.confidence).toBeLessThan(0.9);
  });

  it('leaves the questions and answers untouched', async () => {
    const assessmentId = await seedAssessment();

    await runAssessmentPipeline({ assessmentId, jobId: 'p5-6' });
    const stored = await getAssessment(assessmentId);

    for (const answer of stored.answers) {
      expect(answer as unknown as Record<string, unknown>).not.toHaveProperty('questionId');
    }
    for (const question of stored.questions) {
      expect(question as unknown as Record<string, unknown>).not.toHaveProperty('answerId');
    }
  });

  it('does not contact providers when extraction has not run', async () => {
    const assessmentId = await seedAssessment();

    // Skip both extraction stages, leaving nothing to map.
    await markStageCompleted(assessmentId, 'EXTRACTING_QUESTIONS');
    await markStageCompleted(assessmentId, 'EXTRACTING_ANSWERS');

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'p5-7' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    expect((await getAssessment(assessmentId)).mappings).toEqual([]);
  });

  it('skips mapping when the stage record already shows it complete', async () => {
    const assessmentId = await seedAssessment();

    await runAssessmentPipeline({ assessmentId, jobId: 'p5-8' });
    expect(fakeAI.adjudicateCalls).toBeGreaterThan(0);

    fakeAI.reset();
    const replay = await runAssessmentPipeline({ assessmentId, jobId: 'p5-8' });

    expect(replay.skippedStages).toContain('MAPPING');
    expect(fakeAI.adjudicateCalls).toBe(0);
    expect((await getAssessment(assessmentId)).mappings).toHaveLength(3);
  });

  it('propagates a transient adjudication failure for the queue to retry', async () => {
    const assessmentId = await seedAssessment();
    fakeAI.configure({
      candidates: QUESTIONS,
      answerCandidates: ANSWERS,
      adjudicationError: new DependencyUnavailableError('rate limited'),
    });

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'p5-9' }),
    ).rejects.toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });

    const stored = await getAssessment(assessmentId);

    expect(stored.stage).toBe('MAPPING');
    expect(stored.mappings).toEqual([]);
    // Extraction still stands, so the retry will not redo it.
    expect(stored.questions).toHaveLength(3);
    expect(stored.answers).toHaveLength(3);
  });

  it('succeeds on retry without re-extracting', async () => {
    const assessmentId = await seedAssessment();
    fakeAI.configure({
      candidates: QUESTIONS,
      answerCandidates: ANSWERS,
      adjudicationError: new DependencyUnavailableError('temporary outage'),
    });

    await expect(runAssessmentPipeline({ assessmentId, jobId: 'p5-10' })).rejects.toThrow();
    expect(fakeAI.extractQuestionsCalls).toBe(1);

    fakeAI.configure({ candidates: QUESTIONS, answerCandidates: ANSWERS });
    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'p5-10' });

    expect(outcome.skippedStages).toContain('EXTRACTING_QUESTIONS');
    expect(outcome.executedStages).toContain('MAPPING');
    expect(fakeAI.extractQuestionsCalls).toBe(1);
    expect((await getAssessment(assessmentId)).mappings).toHaveLength(3);
  });

  it('keeps marks out of the mapping records', async () => {
    const assessmentId = await seedAssessment();
    await runAssessmentPipeline({ assessmentId, jobId: 'p5-11' });

    const stored = await getAssessment(assessmentId);

    // Grading is a later stage with its own records. A mapping says which
    // question an answer belongs to and nothing about what it earned.
    expect(JSON.stringify(stored.mappings)).not.toContain('awarded');
    expect(JSON.stringify(stored.mappings)).not.toContain('feedback');
  });
});

describe.skipIf(!available)('MAPPING through a real BullMQ worker', () => {
  let queue: Queue<AssessmentJobData>;
  let queueConnection: Redis;
  let worker: Worker<AssessmentJobData> | null = null;

  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot ??= await mkdtemp(join(tmpdir(), 'veda-phase5-queue-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(embeddings());

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

  it('retries a transient adjudication failure and maps on a later attempt', async () => {
    fakeAI.reset();

    let attempts = 0;
    fakeAI.configure({
      candidates: QUESTIONS,
      answerCandidates: ANSWERS,
      onAdjudicate: () => {
        attempts += 1;
        if (attempts <= 1) throw new DependencyUnavailableError('rate limited');
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

    const jobId = 'queue-mapping-1';
    await queue.add(JOB_NAMES.PREPARE, { assessmentId, jobId }, buildJobOptions({ jobId }));
    await completed;

    const stored = await getAssessment(assessmentId);

    expect(attempts).toBeGreaterThan(1);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.mappings).toHaveLength(3);
    // Extraction ran once across both attempts.
    expect(fakeAI.extractQuestionsCalls).toBe(1);

    fakeAI.configure({ candidates: QUESTIONS, answerCandidates: ANSWERS });
  }, 40_000);
});
