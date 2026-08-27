import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Queue, Worker } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setAssessmentStore } from '@/lib/services/assessment-store';
import { LocalDocumentStorage, setDocumentStorage } from '@/lib/storage/local-storage';
import { getDocumentStorage, preparedPageKey } from '@/lib/storage';
import { createAssessment, getAssessment, markStageCompleted } from '@/lib/services/assessment-service';
import { uploadDocument, getDocument } from '@/lib/services/document/document-service';
import { prepareAssessmentDocuments } from '@/lib/services/document/document-preparation-service';
import { runAssessmentPipeline } from '@/lib/services/pipeline/runner';
import { STAGE_HANDLERS } from '@/lib/services/pipeline/stages';
import { FakeAIProvider, setAIProvider } from '@/lib/providers/ai';
import { FakeEmbeddingProvider, setEmbeddingProvider } from '@/lib/providers/embeddings';
import { JOB_NAMES, buildJobOptions, type AssessmentJobData } from '@/lib/queue/jobs';
import { logger } from '@/lib/logger';
import { A4_LANDSCAPE, A4_PORTRAIT, makeMalformedPdf, makePdf, makePng } from '../fixtures/documents';

/**
 * Phase 2 integration: document preparation running against real Redis
 * state, real storage, and a real BullMQ worker.
 *
 * Skipped when Redis is unreachable. Run `npm run redis:up` first.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_QUEUE = 'assessment-processing-phase2-test';

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
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — Phase 2 integration tests skipped.`);
}

let storageRoot: string;
const createdAssessments: string[] = [];

async function seedAssessment(
  documents: Array<{ type: 'QUESTION_PAPER' | 'ANSWER_SHEET'; data: Buffer; filename: string; mime: string }>,
): Promise<string> {
  const assessment = await createAssessment({ title: 'phase 2 integration' });
  createdAssessments.push(assessment.id);

  for (const document of documents) {
    await uploadDocument({
      assessmentId: assessment.id,
      type: document.type,
      filename: document.filename,
      declaredMimeType: document.mime,
      data: document.data,
    });
  }

  return assessment.id;
}

function context(assessmentId: string, jobId = 'job-integration') {
  return { assessmentId, jobId, logger };
}

describe.skipIf(!available)('document preparation against real Redis', () => {
  beforeAll(async () => {
    // The real Redis-backed store, not the in-memory test double.
    setAssessmentStore(null);
    storageRoot = await mkdtemp(join(tmpdir(), 'veda-phase2-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
  });

  afterAll(async () => {
    setDocumentStorage(null);
    await rm(storageRoot, { recursive: true, force: true });

    const redis = new Redis(REDIS_URL, { maxRetriesPerRequest: null });
    for (const id of createdAssessments) {
      await redis.del(`veda-test:assessment:${id}`).catch(() => undefined);
    }
    await redis.quit().catch(() => redis.disconnect());
  });

  it('prepares a multi-page PDF into canonical pages', async () => {
    const assessmentId = await seedAssessment([
      {
        type: 'QUESTION_PAPER',
        data: makePdf([A4_PORTRAIT, A4_PORTRAIT, A4_LANDSCAPE]),
        filename: 'paper.pdf',
        mime: 'application/pdf',
      },
    ]);

    const summary = await prepareAssessmentDocuments(context(assessmentId));

    expect(summary.totalPages).toBe(3);
    expect(summary.documents[0]).toMatchObject({
      type: 'QUESTION_PAPER',
      pageCount: 3,
      renderedPages: 3,
      reusedPages: 0,
      reusedDocument: false,
    });

    const stored = await getAssessment(assessmentId);
    const document = stored.documents[0]!;

    expect(document.status).toBe('READY');
    expect(document.pageCount).toBe(3);
    expect(document.pages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(document.preparedAt).not.toBeNull();
  });

  it('writes exactly one bitmap per page, addressable by page number', async () => {
    const assessmentId = await seedAssessment([
      {
        type: 'ANSWER_SHEET',
        data: makePdf([A4_PORTRAIT, A4_PORTRAIT]),
        filename: 'answers.pdf',
        mime: 'application/pdf',
      },
    ]);

    await prepareAssessmentDocuments(context(assessmentId));

    const document = (await getAssessment(assessmentId)).documents[0]!;
    const storage = getDocumentStorage();

    for (const page of document.pages) {
      expect(page.storageKey).toBe(
        preparedPageKey(assessmentId, document.id, page.pageNumber),
      );
      expect(await storage.exists(page.storageKey)).toBe(true);
      expect(page.sizeBytes).toBeGreaterThan(0);
      expect(page.mimeType).toBe('image/png');
    }
  });

  it('normalizes a PNG into the same single-page representation', async () => {
    const assessmentId = await seedAssessment([
      { type: 'ANSWER_SHEET', data: await makePng(1200, 1600), filename: 'scan.png', mime: 'image/png' },
    ]);

    await prepareAssessmentDocuments(context(assessmentId));

    const document = (await getAssessment(assessmentId)).documents[0]!;
    const page = document.pages[0]!;

    expect(document.pageCount).toBe(1);
    expect(page.pageNumber).toBe(1);
    expect(page.sourceWidth).toBe(1200);
    expect(page.sourceHeight).toBe(1600);
    expect(page.aspectRatio).toBeCloseTo(page.width / page.height, 4);
  });

  it('prepares both documents of an assessment independently', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT, A4_PORTRAIT]), filename: 'p.pdf', mime: 'application/pdf' },
      { type: 'ANSWER_SHEET', data: await makePng(800, 1000), filename: 'a.png', mime: 'image/png' },
    ]);

    const summary = await prepareAssessmentDocuments(context(assessmentId));

    expect(summary.documents).toHaveLength(2);
    expect(summary.totalPages).toBe(3);

    const stored = await getAssessment(assessmentId);
    expect(stored.documents.every((document) => document.status === 'READY')).toBe(true);
  });

  it('fails a malformed PDF permanently rather than retrying forever', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makeMalformedPdf(), filename: 'broken.pdf', mime: 'application/pdf' },
    ]);

    await expect(prepareAssessmentDocuments(context(assessmentId))).rejects.toMatchObject({
      code: 'INVALID_DOCUMENT',
      retryable: false,
    });

    const document = (await getAssessment(assessmentId)).documents[0]!;
    expect(document.status).toBe('FAILED');
    expect(document.failure?.code).toBe('INVALID_DOCUMENT');
  });

  it('refuses to prepare an assessment with no documents', async () => {
    const assessment = await createAssessment({ title: 'empty' });
    createdAssessments.push(assessment.id);

    await expect(prepareAssessmentDocuments(context(assessment.id))).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
    });
  });
});

describe.skipIf(!available)('preparation idempotency', () => {
  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot ??= await mkdtemp(join(tmpdir(), 'veda-phase2-idem-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
  });

  it('reuses a fully prepared document instead of re-rendering it', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT, A4_PORTRAIT]), filename: 'p.pdf', mime: 'application/pdf' },
    ]);

    const first = await prepareAssessmentDocuments(context(assessmentId));
    expect(first.documents[0]?.renderedPages).toBe(2);

    const second = await prepareAssessmentDocuments(context(assessmentId));
    expect(second.documents[0]).toMatchObject({
      reusedDocument: true,
      renderedPages: 0,
      reusedPages: 2,
    });
  });

  it('produces no duplicate prepared pages across repeated runs', async () => {
    const assessmentId = await seedAssessment([
      { type: 'ANSWER_SHEET', data: makePdf([A4_PORTRAIT, A4_LANDSCAPE, A4_PORTRAIT]), filename: 'a.pdf', mime: 'application/pdf' },
    ]);

    await prepareAssessmentDocuments(context(assessmentId));
    await prepareAssessmentDocuments(context(assessmentId));
    await prepareAssessmentDocuments(context(assessmentId));

    const document = (await getAssessment(assessmentId)).documents[0]!;
    const pageNumbers = document.pages.map((page) => page.pageNumber);

    expect(document.pages).toHaveLength(3);
    expect(new Set(pageNumbers).size).toBe(3);
    expect(pageNumbers).toEqual([1, 2, 3]);
    expect(document.pageCount).toBe(3);
  });

  it('re-renders a page whose bitmap vanished from storage', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT, A4_PORTRAIT]), filename: 'p.pdf', mime: 'application/pdf' },
    ]);

    await prepareAssessmentDocuments(context(assessmentId));

    const document = await getDocument(assessmentId, (await getAssessment(assessmentId)).documents[0]!.id);
    await getDocumentStorage().delete(document.pages[1]!.storageKey);

    // The record still claims READY, but a lost blob means it is not.
    const rerun = await prepareAssessmentDocuments(context(assessmentId));

    expect(rerun.documents[0]?.reusedDocument).toBe(false);
    expect(rerun.documents[0]?.reusedPages).toBe(1);
    expect(rerun.documents[0]?.renderedPages).toBe(1);

    const after = (await getAssessment(assessmentId)).documents[0]!;
    expect(after.pages).toHaveLength(2);
    expect(await getDocumentStorage().exists(after.pages[1]!.storageKey)).toBe(true);
  });

  it('re-renders a page whose stored bitmap is truncated', async () => {
    const assessmentId = await seedAssessment([
      { type: 'ANSWER_SHEET', data: makePdf([A4_PORTRAIT]), filename: 'a.pdf', mime: 'application/pdf' },
    ]);

    await prepareAssessmentDocuments(context(assessmentId));

    const document = (await getAssessment(assessmentId)).documents[0]!;
    // Simulate an interrupted write: present, non-empty, but not a valid PNG.
    await getDocumentStorage().put(document.pages[0]!.storageKey, Buffer.from('partial'), {
      contentType: 'image/png',
    });

    const rerun = await prepareAssessmentDocuments(context(assessmentId));
    expect(rerun.documents[0]?.renderedPages).toBe(1);
  });
});

describe.skipIf(!available)('PREPARING stage through the pipeline', () => {
  // A full pipeline run now reaches EXTRACTING_QUESTIONS, which needs an AI
  // provider. These tests are about preparation and stage sequencing, so a
  // scripted provider stands in for the model.
  const fakeAI = new FakeAIProvider({
    candidates: [
      {
        labelRaw: 'Q1',
        text: 'Placeholder question for pipeline sequencing.',
        marks: 2,
        pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.7, height: 0.1 }],
      },
    ],
    answerCandidates: [
      {
        claimedLabelRaw: 'Q1',
        text: 'Placeholder answer for pipeline sequencing.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.3, width: 0.7, height: 0.1, kind: 'text' }],
      },
    ],
  });

  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot ??= await mkdtemp(join(tmpdir(), 'veda-phase2-stage-'));
    setDocumentStorage(new LocalDocumentStorage(storageRoot));
    setAIProvider(fakeAI);
    setEmbeddingProvider(new FakeEmbeddingProvider());
  });

  beforeEach(() => {
    // The call counter is an assertion target, so it starts clean per test.
    fakeAI.reset();
  });

  afterAll(() => {
    setAIProvider(null);
    setEmbeddingProvider(null);
  });

  it('runs preparation as the PREPARING stage of the existing pipeline', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT, A4_PORTRAIT]), filename: 'p.pdf', mime: 'application/pdf' },
      { type: 'ANSWER_SHEET', data: await makePng(600, 800), filename: 'a.png', mime: 'image/png' },
    ]);

    const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'job-stage-1' });

    expect(outcome.executedStages[0]).toBe('PREPARING');
    expect(outcome.executedStages).toHaveLength(6);

    const stored = await getAssessment(assessmentId);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.documents.every((document) => document.status === 'READY')).toBe(true);
    expect(stored.documents.find((d) => d.type === 'QUESTION_PAPER')?.pageCount).toBe(2);
  });

  it('skips PREPARING when the stage record shows it complete, and refuses to extract', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT]), filename: 'p.pdf', mime: 'application/pdf' },
    ]);

    // Phase 1's stage-level idempotency, unchanged.
    await markStageCompleted(assessmentId, 'PREPARING');

    // PREPARING is skipped, so the document is never prepared — and
    // extraction must then refuse rather than spend a model call on pages
    // that do not exist.
    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'job-stage-2' }),
    ).rejects.toMatchObject({ code: 'CONFLICT' });

    const stored = await getAssessment(assessmentId);
    expect(stored.documents[0]!.status).toBe('UPLOADED');
    expect(stored.stage).toBe('EXTRACTING_QUESTIONS');
    expect(stored.questions).toEqual([]);
    expect(fakeAI.extractQuestionsCalls).toBe(0);
  });

  it('propagates a preparation failure so the queue can decide about retrying', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makeMalformedPdf(), filename: 'broken.pdf', mime: 'application/pdf' },
    ]);

    await expect(
      runAssessmentPipeline({ assessmentId, jobId: 'job-stage-3' }),
    ).rejects.toMatchObject({ code: 'INVALID_DOCUMENT' });

    const stored = await getAssessment(assessmentId);
    expect(stored.stage).toBe('PREPARING');
    expect(stored.documents[0]?.status).toBe('FAILED');
  });

  it('resumes after a transient failure without re-rendering finished pages', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT]), filename: 'p.pdf', mime: 'application/pdf' },
      { type: 'ANSWER_SHEET', data: await makePng(400, 600), filename: 'a.png', mime: 'image/png' },
    ]);

    const original = STAGE_HANDLERS[JOB_NAMES.EXTRACT_QUESTIONS];
    let attempts = 0;

    // Fail the stage *after* PREPARING, so the retry has completed work to
    // skip. The retry delegates to the real handler, because the stages that
    // follow it need genuinely extracted questions to run.
    STAGE_HANDLERS[JOB_NAMES.EXTRACT_QUESTIONS] = async (ctx) => {
      attempts += 1;
      if (attempts === 1) throw new Error('transient downstream failure');
      await original!(ctx);
    };

    try {
      await expect(
        runAssessmentPipeline({ assessmentId, jobId: 'job-stage-4' }),
      ).rejects.toThrow('transient downstream failure');

      const outcome = await runAssessmentPipeline({ assessmentId, jobId: 'job-stage-4' });

      expect(outcome.skippedStages).toContain('PREPARING');
      expect(outcome.executedStages).not.toContain('PREPARING');

      const stored = await getAssessment(assessmentId);
      expect(stored.documents.every((d) => d.status === 'READY')).toBe(true);
      expect(stored.documents.find((d) => d.type === 'QUESTION_PAPER')!.pages).toHaveLength(1);
    } finally {
      STAGE_HANDLERS[JOB_NAMES.EXTRACT_QUESTIONS] = original!;
    }
  });
});

describe.skipIf(!available)('PREPARING through a real BullMQ worker', () => {
  let queue: Queue<AssessmentJobData>;
  let queueConnection: Redis;
  let worker: Worker<AssessmentJobData> | null = null;

  const fakeAI = new FakeAIProvider({
    candidates: [
      {
        labelRaw: 'Q1',
        text: 'Placeholder question for queue delivery.',
        marks: null,
        pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.7, height: 0.1 }],
      },
    ],
    answerCandidates: [
      {
        claimedLabelRaw: null,
        text: 'Placeholder answer for queue delivery.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.3, width: 0.7, height: 0.1, kind: 'text' }],
      },
    ],
  });

  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot ??= await mkdtemp(join(tmpdir(), 'veda-phase2-queue-'));
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

  it('prepares documents when the job is delivered by the queue', async () => {
    const assessmentId = await seedAssessment([
      { type: 'QUESTION_PAPER', data: makePdf([A4_PORTRAIT, A4_LANDSCAPE]), filename: 'p.pdf', mime: 'application/pdf' },
      { type: 'ANSWER_SHEET', data: await makePng(900, 1200), filename: 'a.png', mime: 'image/png' },
    ]);

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
      worker!.once('failed', (_job, error) => {
        clearTimeout(timer);
        reject(error);
      });
    });

    const jobId = 'queue-prepare-1';
    await queue.add(JOB_NAMES.PREPARE, { assessmentId, jobId }, buildJobOptions({ jobId }));
    await completed;

    const stored = await getAssessment(assessmentId);

    expect(stored.status).toBe('COMPLETED');
    expect(stored.documents).toHaveLength(2);
    expect(stored.documents.every((document) => document.status === 'READY')).toBe(true);
    expect(stored.documents.find((d) => d.type === 'QUESTION_PAPER')?.pages).toHaveLength(2);
    expect(stored.documents.find((d) => d.type === 'ANSWER_SHEET')?.pages).toHaveLength(1);
  }, 40_000);
});
