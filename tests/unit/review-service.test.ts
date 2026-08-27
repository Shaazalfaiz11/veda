import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const {
  acceptReview,
  getReview,
  getReviewSummary,
  listAuditEvents,
  listReviews,
  rejectReview,
  remapReview,
  skipReview,
} = await import('@/lib/services/review');

const { createAssessment, getAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { resolveEffectiveMapping } = await import('@/lib/domain/review');
const { ConflictError, NotFoundError, ValidationError } = await import('@/lib/errors');

import type { AnswerMapping } from '@/lib/domain/mapping';
import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';

const store = new InMemoryAssessmentStore();

const Q1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const Q2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const Q3 = 'a1b2c3d4-0000-4000-8000-000000000003';

function question(id: string, label: string): Question {
  return {
    id,
    labelRaw: label,
    normalizedLabel: label.replace(/\D/g, ''),
    sortKey: { major: Number(label.replace(/\D/g, '')), minor: null, roman: null },
    parentLabel: null,
    isSubQuestion: false,
    text: `Question ${label}`,
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
  };
}

function answer(id: string): Answer {
  return {
    id,
    claimedLabelRaw: null,
    claimedLabelNormalized: null,
    text: `Answer body ${id}`,
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.05, kind: 'text' }],
    pageNumbers: [1],
    spansPages: false,
    hasUncertainSegments: false,
    containsDiagram: false,
    documentPosition: 0,
  };
}

function mapping(
  answerId: string,
  questionId: string | null,
  band: 'HIGH' | 'MEDIUM' | 'LOW',
): AnswerMapping {
  const confidence = band === 'HIGH' ? 0.95 : band === 'MEDIUM' ? 0.78 : 0.55;

  return {
    id: `m-${answerId}`,
    answerId,
    questionId,
    status:
      questionId === null
        ? 'UNMAPPED'
        : band === 'HIGH'
          ? 'AUTO_MAPPED'
          : band === 'MEDIUM'
            ? 'REVIEW_REQUIRED'
            : 'HUMAN_REVIEW',
    confidence,
    confidenceBand: band,
    signals: {
      label: 0.5,
      labelKind: 'NO_LABEL',
      semantic: 0.7,
      semanticCosine: 0.85,
      position: 0.6,
      structure: 0.5,
    },
    reasonCodes: ['SEMANTIC_MATCH'],
    candidates: [
      {
        questionId: questionId ?? Q1,
        questionLabelRaw: 'Q1',
        signals: {
          label: 0.5,
          labelKind: 'NO_LABEL',
          semantic: 0.7,
          semanticCosine: 0.85,
          position: 0.6,
          structure: 0.5,
        },
        candidateScore: 0.72,
        llmSelected: true,
        llmConfidence: 0.8,
        finalConfidence: confidence,
      },
    ],
    verification: {
      decision: 'MATCH',
      questionId,
      reasonCode: 'SUBJECT_MATCH',
      modelConfidence: 0.8,
      provider: 'fake',
      model: 'fake-model-v1',
      promptVersion: 'mapping-adjudication/v1',
    },
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

/** Seeds an assessment with mappings and their implied review queue. */
async function seed(mappings: AnswerMapping[]): Promise<string> {
  const assessment = await createAssessment({ title: 'review' });
  const { buildReviewQueue } = await import('@/lib/services/review');

  await store.update(assessment.id, (current) => ({
    ...current,
    questions: [question(Q1, 'Q1'), question(Q2, 'Q2'), question(Q3, 'Q3')],
    answers: mappings.map((m) => answer(m.answerId)),
    mappings,
    reviews: buildReviewQueue(assessment.id, mappings, []),
  }));

  return assessment.id;
}

async function firstReviewId(assessmentId: string): Promise<string> {
  const reviews = await listReviews(assessmentId);
  return reviews[0]!.id;
}

async function effectiveFor(assessmentId: string, answerId: string) {
  const assessment = await getAssessment(assessmentId);
  const map = assessment.mappings.find((m) => m.answerId === answerId)!;
  const review = assessment.reviews.find((r) => r.answerId === answerId) ?? null;
  return resolveEffectiveMapping(map, review);
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('ACCEPT', () => {
  it("confirms the AI's question and records that a human did so", async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    const outcome = await acceptReview({ assessmentId, reviewId, reviewerId: 'teacher-1' });

    expect(outcome.review.status).toBe('RESOLVED');
    expect(outcome.review.decision?.action).toBe('ACCEPT');
    expect(outcome.effective).toMatchObject({ questionId: Q1, source: 'HUMAN' });
    expect(outcome.changed).toBe(true);
  });

  it('leaves the AI mapping exactly as it was', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const before = JSON.stringify((await getAssessment(assessmentId)).mappings);

    await acceptReview({ assessmentId, reviewId: await firstReviewId(assessmentId) });

    expect(JSON.stringify((await getAssessment(assessmentId)).mappings)).toBe(before);
  });
});

describe('REMAP', () => {
  it('substitutes the teacher’s question without touching the AI mapping', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    const outcome = await remapReview({
      assessmentId,
      reviewId,
      questionId: Q2,
      reason: 'Answer belongs to Q2.',
      reviewerId: 'teacher-1',
    });

    expect(outcome.effective).toMatchObject({ questionId: Q2, source: 'HUMAN' });

    const stored = await getAssessment(assessmentId);
    // The AI still says Q1, and always will.
    expect(stored.mappings[0]!.questionId).toBe(Q1);
    expect(stored.mappings[0]!.confidence).toBe(0.78);
    expect(stored.reviews[0]!.original.questionId).toBe(Q1);
    expect(stored.reviews[0]!.original.confidence).toBe(0.78);
  });

  it('keeps the original candidates and adjudication intact', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const before = await getAssessment(assessmentId);
    const originalCandidates = JSON.stringify(before.mappings[0]!.candidates);
    const originalVerification = JSON.stringify(before.mappings[0]!.verification);

    await remapReview({
      assessmentId,
      reviewId: await firstReviewId(assessmentId),
      questionId: Q2,
    });

    const after = await getAssessment(assessmentId);
    expect(JSON.stringify(after.mappings[0]!.candidates)).toBe(originalCandidates);
    expect(JSON.stringify(after.mappings[0]!.verification)).toBe(originalVerification);
    expect(JSON.stringify(after.reviews[0]!.original.candidates)).toBe(originalCandidates);
  });

  it('rejects a question that is not on this assessment', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await expect(
      remapReview({
        assessmentId,
        reviewId: await firstReviewId(assessmentId),
        questionId: 'ffffffff-0000-4000-8000-000000000000',
      }),
    ).rejects.toThrow(NotFoundError);
  });

  it('rejects a reason longer than the limit', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await expect(
      remapReview({
        assessmentId,
        reviewId: await firstReviewId(assessmentId),
        questionId: Q2,
        reason: 'x'.repeat(1001),
      }),
    ).rejects.toThrow(ValidationError);
  });
});

describe('REJECT', () => {
  it('leaves the answer unmapped while preserving what the AI thought', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    const outcome = await rejectReview({
      assessmentId,
      reviewId: await firstReviewId(assessmentId),
      reason: 'AI selected the wrong subquestion.',
    });

    expect(outcome.effective).toMatchObject({ questionId: null, source: 'HUMAN' });

    const stored = await getAssessment(assessmentId);
    expect(stored.mappings[0]!.questionId).toBe(Q1);
    expect(stored.reviews[0]!.original.questionId).toBe(Q1);
  });
});

describe('SKIP', () => {
  it('leaves the item unresolved and the AI mapping in force', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    const outcome = await skipReview({
      assessmentId,
      reviewId: await firstReviewId(assessmentId),
    });

    expect(outcome.review.status).toBe('SKIPPED');
    // Deferring is not agreeing: the AI's mapping still applies.
    expect(outcome.effective).toMatchObject({ questionId: Q1, source: 'AI' });
  });

  it('is never silently converted into a decision', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    await skipReview({ assessmentId, reviewId });
    const review = await getReview(assessmentId, reviewId);

    expect(review.decision?.action).toBe('SKIP');
    expect(review.status).not.toBe('RESOLVED');
  });

  it('can be picked up again and resolved later', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    await skipReview({ assessmentId, reviewId });
    const outcome = await acceptReview({ assessmentId, reviewId });

    expect(outcome.review.status).toBe('RESOLVED');
    expect(outcome.changed).toBe(true);
  });
});

describe('effective mapping', () => {
  it('uses the AI mapping when nobody has reviewed', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    expect(await effectiveFor(assessmentId, 'a-1')).toMatchObject({
      questionId: Q1,
      source: 'AI',
    });
  });

  it('reports a HIGH mapping with no review as AI-sourced', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'HIGH')]);
    expect(await effectiveFor(assessmentId, 'a-1')).toMatchObject({ source: 'AI' });
  });
});

describe('one-to-one conflicts', () => {
  it('refuses a remap onto a question another answer already holds', async () => {
    const assessmentId = await seed([
      mapping('a-1', Q1, 'HIGH'),
      mapping('a-2', Q2, 'MEDIUM'),
    ]);

    const reviews = await listReviews(assessmentId);
    const forA2 = reviews.find((r) => r.answerId === 'a-2')!;

    await expect(
      remapReview({ assessmentId, reviewId: forA2.id, questionId: Q1 }),
    ).rejects.toMatchObject({
      code: 'CONFLICT',
      details: { code: 'QUESTION_ALREADY_ASSIGNED', questionId: Q1, existingAnswerId: 'a-1' },
    });
  });

  it('never silently unmaps the answer already holding the question', async () => {
    const assessmentId = await seed([
      mapping('a-1', Q1, 'HIGH'),
      mapping('a-2', Q2, 'MEDIUM'),
    ]);

    const reviews = await listReviews(assessmentId);
    const forA2 = reviews.find((r) => r.answerId === 'a-2')!;

    await remapReview({ assessmentId, reviewId: forA2.id, questionId: Q1 }).catch(() => null);

    // a-1 is untouched by the failed attempt.
    expect(await effectiveFor(assessmentId, 'a-1')).toMatchObject({ questionId: Q1 });
    expect(await effectiveFor(assessmentId, 'a-2')).toMatchObject({ questionId: Q2 });
  });

  it('allows a remap onto a question freed by a rejection', async () => {
    const assessmentId = await seed([
      mapping('a-1', Q1, 'MEDIUM'),
      mapping('a-2', Q2, 'MEDIUM'),
    ]);

    const reviews = await listReviews(assessmentId);
    const forA1 = reviews.find((r) => r.answerId === 'a-1')!;
    const forA2 = reviews.find((r) => r.answerId === 'a-2')!;

    await rejectReview({ assessmentId, reviewId: forA1.id });
    const outcome = await remapReview({
      assessmentId,
      reviewId: forA2.id,
      questionId: Q1,
    });

    expect(outcome.effective.questionId).toBe(Q1);
  });

  it('allows a remap onto a question no answer holds', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    const outcome = await remapReview({
      assessmentId,
      reviewId: await firstReviewId(assessmentId),
      questionId: Q3,
    });

    expect(outcome.effective.questionId).toBe(Q3);
  });
});

describe('idempotency and concurrency', () => {
  it('treats a repeated ACCEPT as a no-op', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    const first = await acceptReview({ assessmentId, reviewId });
    const second = await acceptReview({ assessmentId, reviewId });

    expect(first.changed).toBe(true);
    expect(second.changed).toBe(false);
    // A double-clicked button leaves one event, not two.
    expect(await listAuditEvents(assessmentId)).toHaveLength(1);
  });

  it('treats a repeated REMAP to the same question as a no-op', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    await remapReview({ assessmentId, reviewId, questionId: Q2 });
    const second = await remapReview({ assessmentId, reviewId, questionId: Q2 });

    expect(second.changed).toBe(false);
    expect(await listAuditEvents(assessmentId)).toHaveLength(1);
  });

  it('refuses to change a decision that is already resolved', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    await acceptReview({ assessmentId, reviewId });

    await expect(
      remapReview({ assessmentId, reviewId, questionId: Q2 }),
    ).rejects.toThrow(ConflictError);
  });

  it('keeps concurrent decisions on different reviews', async () => {
    const assessmentId = await seed([
      mapping('a-1', Q1, 'MEDIUM'),
      mapping('a-2', Q2, 'MEDIUM'),
    ]);

    const reviews = await listReviews(assessmentId);

    await Promise.all([
      acceptReview({ assessmentId, reviewId: reviews[0]!.id }),
      acceptReview({ assessmentId, reviewId: reviews[1]!.id }),
    ]);

    const after = await listReviews(assessmentId);
    expect(after.every((r) => r.status === 'RESOLVED')).toBe(true);
    expect(await listAuditEvents(assessmentId)).toHaveLength(2);
  });
});

describe('audit trail', () => {
  it.each([
    ['ACCEPT', () => acceptReview],
    ['REJECT', () => rejectReview],
    ['SKIP', () => skipReview],
  ])('records a %s', async (action, getFn) => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const reviewId = await firstReviewId(assessmentId);

    await getFn()({ assessmentId, reviewId, reviewerId: 'teacher-9' });

    const [event] = await listAuditEvents(assessmentId);
    expect(event).toMatchObject({
      action,
      answerId: 'a-1',
      reviewId,
      assessmentId,
      originalQuestionId: Q1,
      reviewerId: 'teacher-9',
    });
    expect(Date.parse(event!.occurredAt)).not.toBeNaN();
  });

  it('records a REMAP with both the original and final question', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await remapReview({
      assessmentId,
      reviewId: await firstReviewId(assessmentId),
      questionId: Q2,
      reason: 'Student label was unclear.',
    });

    const [event] = await listAuditEvents(assessmentId);
    expect(event).toMatchObject({
      action: 'REMAP',
      originalQuestionId: Q1,
      finalQuestionId: Q2,
      reason: 'Student label was unclear.',
    });
  });

  it('records a REJECT as ending with no question', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await rejectReview({ assessmentId, reviewId: await firstReviewId(assessmentId) });

    const [event] = await listAuditEvents(assessmentId);
    expect(event).toMatchObject({ originalQuestionId: Q1, finalQuestionId: null });
  });

  it('accepts a null reviewer where there is no authentication', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await acceptReview({ assessmentId, reviewId: await firstReviewId(assessmentId) });

    expect((await listAuditEvents(assessmentId))[0]!.reviewerId).toBeNull();
  });
});

describe('lookup safety', () => {
  it('reports an unknown review id as not found', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await expect(
      getReview(assessmentId, 'ffffffff-0000-4000-8000-000000000000'),
    ).rejects.toThrow(NotFoundError);
  });

  it("does not expose another assessment's review", async () => {
    const first = await seed([mapping('a-1', Q1, 'MEDIUM')]);
    const second = await seed([mapping('a-9', Q2, 'MEDIUM')]);

    const foreignReviewId = (await listReviews(second))[0]!.id;

    // Looked up within the assessment, so it is simply absent — a caller
    // cannot use the response to learn that it exists elsewhere.
    await expect(getReview(first, foreignReviewId)).rejects.toThrow(NotFoundError);
    await expect(
      acceptReview({ assessmentId: first, reviewId: foreignReviewId }),
    ).rejects.toThrow(NotFoundError);
  });
});

describe('summary', () => {
  it('derives counts from the canonical records', async () => {
    const assessmentId = await seed([
      mapping('a-1', Q1, 'HIGH'),
      mapping('a-2', Q2, 'MEDIUM'),
      mapping('a-3', null, 'LOW'),
    ]);

    const before = await getReviewSummary(assessmentId);
    expect(before).toMatchObject({
      totalAnswers: 3,
      autoMapped: 1,
      reviewRequired: 1,
      unmapped: 1,
      totalReviews: 2,
      pending: 2,
      resolved: 0,
    });

    const reviews = await listReviews(assessmentId);
    await acceptReview({ assessmentId, reviewId: reviews[0]!.id });

    const after = await getReviewSummary(assessmentId);
    expect(after.resolved).toBe(1);
    expect(after.pending).toBe(1);
    expect(after.humanOverridden).toBe(1);
  });

  it('counts effectively mapped answers, not just AI ones', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await rejectReview({ assessmentId, reviewId: await firstReviewId(assessmentId) });

    const summary = await getReviewSummary(assessmentId);
    expect(summary.effectivelyMapped).toBe(0);
    expect(summary.effectivelyUnmapped).toBe(1);
  });
});

describe('grading boundary', () => {
  it('records no marks, verdict or feedback anywhere', async () => {
    const assessmentId = await seed([mapping('a-1', Q1, 'MEDIUM')]);

    await remapReview({
      assessmentId,
      reviewId: await firstReviewId(assessmentId),
      questionId: Q2,
    });

    const stored = await getAssessment(assessmentId);
    const raw = JSON.stringify({ reviews: stored.reviews, audit: stored.reviewAudit });

    expect(raw).not.toContain('awarded');
    expect(raw).not.toContain('verdict');
    expect(raw).not.toContain('feedback');
    // A review decision changes the effective mapping and nothing else. It
    // never marks anything, and it never invalidates a grade by itself —
    // re-grading is the grading stage's decision to make.
    expect(stored.grades).toEqual([]);
    expect(stored.grading).toBeNull();
  });
});
