import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Redis } from 'ioredis';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { setAssessmentStore } from '@/lib/services/assessment-store';
import { LocalDocumentStorage, setDocumentStorage } from '@/lib/storage/local-storage';
import { createAssessment, getAssessment } from '@/lib/services/assessment-service';
import { uploadDocument } from '@/lib/services/document/document-service';
import { runAssessmentPipeline } from '@/lib/services/pipeline/runner';
import { FakeAIProvider, setAIProvider } from '@/lib/providers/ai';
import { FakeEmbeddingProvider, setEmbeddingProvider } from '@/lib/providers/embeddings';
import {
  acceptReview,
  listAuditEvents,
  listReviews,
  rejectReview,
  remapReview,
} from '@/lib/services/review';
import { A4_PORTRAIT, makePdf } from '../fixtures/documents';
import type {
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
} from '@/lib/providers/ai';

/**
 * Phase 6 integration: human review over mappings produced by the real
 * pipeline, against real Redis.
 *
 * The point of running it end to end rather than on hand-built fixtures is
 * that the immutability guarantee has to hold over mappings the system
 * actually generated, not ones shaped to make the assertion easy.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';

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
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — Phase 6 integration tests skipped.`);
}

const PHOTOSYNTHESIS_Q = 'Which organelle is primarily involved in photosynthesis?';
const HEART_Q = 'Describe the flow of blood through the human heart.';
const OSMOSIS_Q = 'Define osmosis and give one example.';

const CHLOROPLAST_A = 'The chloroplast is the organelle responsible for photosynthesis.';
const AMBIGUOUS_A = 'It happens inside the cell where the green parts are.';
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

/** One confident, one borderline, one that answers nothing on the paper. */
const ANSWERS: ExtractedAnswerCandidate[] = [
  {
    claimedLabelRaw: 'Q1',
    text: CHLOROPLAST_A,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.1, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: AMBIGUOUS_A,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.35, width: 0.8, height: 0.1, kind: 'text' }],
  },
  {
    claimedLabelRaw: null,
    text: UNRELATED_A,
    regions: [{ pageNumber: 1, x: 0.08, y: 0.6, width: 0.8, height: 0.1, kind: 'text' }],
  },
];

function embeddings() {
  return new FakeEmbeddingProvider({
    dimensions: 4,
    vectors: {
      [PHOTOSYNTHESIS_Q]: [1, 0, 0, 0.1],
      [CHLOROPLAST_A]: [0.97, 0.05, 0, 0.1],
      [HEART_Q]: [0, 1, 0, 0.1],
      [OSMOSIS_Q]: [0, 0, 1, 0.1],
      // Weakly related to photosynthesis: enough to be a candidate, not
      // enough to be confident.
      [AMBIGUOUS_A]: [0.55, 0.2, 0.15, 0.4],
      [UNRELATED_A]: [0.05, 0.05, 0.05, 1],
    },
  });
}

let storageRoot: string;
const createdAssessments: string[] = [];
const fakeAI = new FakeAIProvider({ candidates: QUESTIONS, answerCandidates: ANSWERS });

async function seedAndRun(): Promise<string> {
  const assessment = await createAssessment({ title: 'phase 6 integration' });
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

  await runAssessmentPipeline({ assessmentId: assessment.id, jobId: `p6-${assessment.id}` });
  return assessment.id;
}

describe.skipIf(!available)('review over real pipeline output', () => {
  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot = await mkdtemp(join(tmpdir(), 'veda-phase6-'));
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

  it('queues reviews for the uncertain mappings only', async () => {
    const assessmentId = await seedAndRun();
    const stored = await getAssessment(assessmentId);

    expect(stored.mappings).toHaveLength(3);
    expect(stored.reviews.length).toBeGreaterThan(0);

    // Anything queued is genuinely not a confident auto-mapping.
    for (const review of stored.reviews) {
      const mapping = stored.mappings.find((m) => m.answerId === review.answerId)!;
      const settled = mapping.status === 'AUTO_MAPPED' && mapping.confidenceBand === 'HIGH';
      const contested = mapping.reasonCodes.includes('CONFLICT_RESOLVED');
      expect(!settled || contested).toBe(true);
    }
  });

  it('does not disturb mapping or extraction when the pipeline runs', async () => {
    const assessmentId = await seedAndRun();
    const stored = await getAssessment(assessmentId);

    expect(stored.status).toBe('COMPLETED');
    expect(stored.questions).toHaveLength(3);
    expect(stored.answers).toHaveLength(3);
    // Answers still carry no question reference; mapping remains a separate
    // relationship even with reviews layered on top.
    for (const answer of stored.answers) {
      expect(answer as unknown as Record<string, unknown>).not.toHaveProperty('questionId');
    }
  });

  it('keeps the AI mapping byte-identical through accept, remap and reject', async () => {
    const assessmentId = await seedAndRun();
    const before = JSON.stringify((await getAssessment(assessmentId)).mappings);

    const reviews = await listReviews(assessmentId);
    expect(reviews.length).toBeGreaterThan(0);

    const stored = await getAssessment(assessmentId);
    const freeQuestion = stored.questions.find(
      (q) => !stored.mappings.some((m) => m.questionId === q.id),
    );

    await acceptReview({ assessmentId, reviewId: reviews[0]!.id, reviewerId: 'teacher-1' });

    if (reviews[1] && freeQuestion) {
      await remapReview({
        assessmentId,
        reviewId: reviews[1].id,
        questionId: freeQuestion.id,
        reason: 'Belongs to this question instead.',
      });
    }

    if (reviews[2]) {
      await rejectReview({ assessmentId, reviewId: reviews[2].id, reason: 'Answers nothing.' });
    }

    // The whole AI mapping array is unchanged, to the byte.
    expect(JSON.stringify((await getAssessment(assessmentId)).mappings)).toBe(before);
  });

  it('records one audit event per decision', async () => {
    const assessmentId = await seedAndRun();
    const reviews = await listReviews(assessmentId);

    await acceptReview({ assessmentId, reviewId: reviews[0]!.id, reviewerId: 'teacher-2' });

    const events = await listAuditEvents(assessmentId);
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({
      action: 'ACCEPT',
      assessmentId,
      answerId: reviews[0]!.answerId,
      reviewerId: 'teacher-2',
    });
  });

  it('survives a Redis round trip with the decision intact', async () => {
    const assessmentId = await seedAndRun();
    const reviews = await listReviews(assessmentId);

    await acceptReview({ assessmentId, reviewId: reviews[0]!.id, reviewerId: 'teacher-3' });

    // Re-read from Redis rather than from anything held in memory.
    const reloaded = await getAssessment(assessmentId);
    const review = reloaded.reviews.find((r) => r.id === reviews[0]!.id)!;

    expect(review.status).toBe('RESOLVED');
    expect(review.decision).toMatchObject({ action: 'ACCEPT', reviewerId: 'teacher-3' });
    expect(reloaded.reviewAudit).toHaveLength(1);
  });

  it('preserves human decisions when mapping runs again', async () => {
    const assessmentId = await seedAndRun();
    const reviews = await listReviews(assessmentId);

    await acceptReview({ assessmentId, reviewId: reviews[0]!.id, reviewerId: 'teacher-4' });

    // Replaying the pipeline re-enters MAPPING via the idempotency record.
    await runAssessmentPipeline({ assessmentId, jobId: `p6-${assessmentId}` });

    const after = await getAssessment(assessmentId);
    const review = after.reviews.find((r) => r.id === reviews[0]!.id);

    expect(review?.status).toBe('RESOLVED');
    expect(review?.decision?.reviewerId).toBe('teacher-4');
  });

  it('keeps marks out of the review records', async () => {
    const assessmentId = await seedAndRun();
    const reviews = await listReviews(assessmentId);

    await acceptReview({ assessmentId, reviewId: reviews[0]!.id });

    const stored = await getAssessment(assessmentId);

    // A review decides which question an answer belongs to. What that answer
    // earned is a separate record, written by a separate stage.
    expect(JSON.stringify(stored.reviews)).not.toContain('awarded');
    expect(JSON.stringify(stored.reviews)).not.toContain('feedback');
  });
});
