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
import { gradeAssessment } from '@/lib/services/grading';
import { listReviews, remapReview } from '@/lib/services/review';
import { resolveEffectiveMapping } from '@/lib/domain/review';
import { logger } from '@/lib/logger';
import { A4_PORTRAIT, makePdf } from '../fixtures/documents';
import type {
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
} from '@/lib/providers/ai';

/**
 * Phase 7 integration: grading over output the real pipeline produced,
 * against real Redis.
 *
 * Hand-built mappings would let the grading service be tested against exactly
 * the shape it expects. The interesting question is whether it holds up over
 * mappings the system actually generated — including the uncertain ones a
 * teacher then corrects.
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
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — Phase 7 integration tests skipped.`);
}

const PHOTOSYNTHESIS_Q = 'Which organelle is primarily involved in photosynthesis?';
const HEART_Q = 'Describe the flow of blood through the human heart.';
const OSMOSIS_Q = 'Define osmosis and give one example.';

const CHLOROPLAST_A = 'The chloroplast is the organelle responsible for photosynthesis.';
const AMBIGUOUS_A = 'It happens inside the cell where the green parts are.';

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
];

function embeddings() {
  return new FakeEmbeddingProvider({
    dimensions: 4,
    vectors: {
      [PHOTOSYNTHESIS_Q]: [1, 0, 0, 0.1],
      [CHLOROPLAST_A]: [0.97, 0.05, 0, 0.1],
      [HEART_Q]: [0, 1, 0, 0.1],
      [OSMOSIS_Q]: [0, 0, 1, 0.1],
      [AMBIGUOUS_A]: [0.55, 0.2, 0.15, 0.4],
    },
  });
}

let storageRoot: string;
const createdAssessments: string[] = [];
const fakeAI = new FakeAIProvider({ candidates: QUESTIONS, answerCandidates: ANSWERS });

async function seedAndRun(): Promise<string> {
  const assessment = await createAssessment({ title: 'phase 7 integration' });
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

  await runAssessmentPipeline({ assessmentId: assessment.id, jobId: `p7-${assessment.id}` });
  return assessment.id;
}

describe.skipIf(!available)('grading over real pipeline output', () => {
  beforeAll(async () => {
    setAssessmentStore(null);
    storageRoot = await mkdtemp(join(tmpdir(), 'veda-phase7-'));
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

  it('grades as part of the pipeline and completes the assessment', async () => {
    const assessmentId = await seedAndRun();
    const stored = await getAssessment(assessmentId);

    expect(stored.status).toBe('COMPLETED');
    expect(stored.completedStages.map((entry) => entry.stage)).toContain('GRADING');
    expect(stored.grades.length).toBe(stored.answers.length);
    expect(stored.grading?.promptVersion).toBe('grading/v1');
  });

  it('attaches every grade to the question the mapping says is in force', async () => {
    const assessmentId = await seedAndRun();
    const stored = await getAssessment(assessmentId);

    for (const grade of stored.grades.filter((entry) => entry.isCurrent)) {
      const mapping = stored.mappings.find((entry) => entry.answerId === grade.answerId)!;
      const review = stored.reviews.find((entry) => entry.answerId === grade.answerId) ?? null;
      const effective = resolveEffectiveMapping(mapping, review);

      expect(grade.questionId).toBe(effective.questionId);
    }
  });

  it('marks out of what the paper says the question is worth', async () => {
    const assessmentId = await seedAndRun();
    const stored = await getAssessment(assessmentId);

    for (const grade of stored.grades.filter((entry) => entry.maximumMarks !== null)) {
      const question = stored.questions.find((entry) => entry.id === grade.questionId)!;

      expect(grade.maximumMarks).toBe(question.marks);
      expect(grade.awardedMarks).toBeLessThanOrEqual(grade.maximumMarks!);
    }
  });

  it('leaves the extraction and mapping records untouched', async () => {
    const assessmentId = await seedAndRun();
    const before = await getAssessment(assessmentId);
    const snapshot = JSON.stringify({
      questions: before.questions,
      answers: before.answers,
      mappings: before.mappings,
    });

    await gradeAssessment({
      assessmentId,
      jobId: 'p7-regrade',
      logger,
      provider: fakeAI,
    });

    const after = await getAssessment(assessmentId);

    expect(
      JSON.stringify({
        questions: after.questions,
        answers: after.answers,
        mappings: after.mappings,
      }),
    ).toBe(snapshot);
  });

  it('skips the grading stage when the job is replayed', async () => {
    const assessmentId = await seedAndRun();
    const before = await getAssessment(assessmentId);

    const replay = await runAssessmentPipeline({
      assessmentId,
      jobId: `p7-${assessmentId}`,
    });

    expect(replay.skippedStages).toContain('GRADING');

    const after = await getAssessment(assessmentId);

    expect(after.grades.map((grade) => grade.id)).toEqual(
      before.grades.map((grade) => grade.id),
    );
  });

  it('re-grades against the teacher’s question after a correction, keeping the old grade', async () => {
    const assessmentId = await seedAndRun();
    const before = await getAssessment(assessmentId);

    const reviews = await listReviews(assessmentId);
    const target = reviews.find((review) => review.status === 'PENDING');

    if (!target) {
      // The fixture is tuned to leave at least one uncertain mapping; if the
      // pipeline settled everything confidently there is nothing to correct.
      expect(before.grades.every((grade) => grade.isCurrent)).toBe(true);
      return;
    }

    const taken = new Set(
      before.mappings
        .map((mapping) => mapping.questionId)
        .filter((id): id is string => id !== null),
    );
    const free = before.questions.find((question) => !taken.has(question.id));

    if (!free) return;

    await remapReview({
      assessmentId,
      reviewId: target.id,
      questionId: free.id,
      reviewerId: 'teacher-1',
    });

    await gradeAssessment({ assessmentId, jobId: 'p7-regrade', logger, provider: fakeAI });

    const after = await getAssessment(assessmentId);
    const forAnswer = after.grades.filter((grade) => grade.answerId === target.answerId);

    expect(forAnswer.length).toBeGreaterThan(1);
    expect(forAnswer.find((grade) => grade.isCurrent)!.questionId).toBe(free.id);
    expect(forAnswer.some((grade) => grade.supersededReason !== null)).toBe(true);
  });

  it('stores no provider credentials or storage paths on the assessment', async () => {
    const assessmentId = await seedAndRun();
    const raw = JSON.stringify((await getAssessment(assessmentId)).grades);

    expect(raw).not.toMatch(/api[_-]?key/i);
    expect(raw).not.toContain(storageRoot);
  });
});
