import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { GET: listRoute } = await import('@/app/api/assessments/[assessmentId]/reviews/route');
const { GET: detailRoute } = await import(
  '@/app/api/assessments/[assessmentId]/reviews/[reviewId]/route'
);
const { POST: acceptRoute } = await import(
  '@/app/api/assessments/[assessmentId]/reviews/[reviewId]/accept/route'
);
const { POST: remapRoute } = await import(
  '@/app/api/assessments/[assessmentId]/reviews/[reviewId]/remap/route'
);
const { POST: rejectRoute } = await import(
  '@/app/api/assessments/[assessmentId]/reviews/[reviewId]/reject/route'
);
const { POST: skipRoute } = await import(
  '@/app/api/assessments/[assessmentId]/reviews/[reviewId]/skip/route'
);
const { GET: mappingsRoute } = await import(
  '@/app/api/assessments/[assessmentId]/mappings/route'
);

const { createAssessment, getAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { buildReviewQueue } = await import('@/lib/services/review');

import type { AnswerMapping } from '@/lib/domain/mapping';
import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';

const store = new InMemoryAssessmentStore();
const UNKNOWN = 'ffffffff-0000-4000-8000-000000000000';

const Q1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const Q2 = 'a1b2c3d4-0000-4000-8000-000000000002';

function question(id: string, label: string): Question {
  return {
    id,
    labelRaw: label,
    normalizedLabel: label.replace(/\D/g, ''),
    sortKey: { major: Number(label.replace(/\D/g, '')), minor: null, roman: null },
    parentLabel: null,
    isSubQuestion: false,
    text: `Question ${label} text`,
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
  };
}

function answer(id: string): Answer {
  return {
    id,
    claimedLabelRaw: 'Q1',
    claimedLabelNormalized: '1',
    text: `Student answer ${id}`,
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.05, kind: 'text' }],
    pageNumbers: [1],
    spansPages: false,
    hasUncertainSegments: false,
    containsDiagram: false,
    documentPosition: 0,
  };
}

function mapping(answerId: string, questionId: string | null): AnswerMapping {
  return {
    id: `m-${answerId}`,
    answerId,
    questionId,
    status: questionId ? 'REVIEW_REQUIRED' : 'UNMAPPED',
    confidence: questionId ? 0.78 : 0.4,
    confidenceBand: questionId ? 'MEDIUM' : 'LOW',
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
        finalConfidence: 0.78,
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

function ctx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

function reviewCtx(assessmentId: string, reviewId: string) {
  return { params: Promise.resolve({ assessmentId, reviewId }) };
}

function post(body: unknown, raw?: string) {
  return new Request('http://localhost/action', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: raw ?? JSON.stringify(body ?? {}),
  });
}

async function seed(): Promise<{ assessmentId: string; reviewId: string }> {
  const assessment = await createAssessment({ title: 'review api' });
  const mappings = [mapping('a-1', Q1)];

  await store.update(assessment.id, (current) => ({
    ...current,
    questions: [question(Q1, 'Q1'), question(Q2, 'Q2')],
    answers: [answer('a-1')],
    mappings,
    reviews: buildReviewQueue(assessment.id, mappings, []),
  }));

  const stored = await getAssessment(assessment.id);
  return { assessmentId: assessment.id, reviewId: stored.reviews[0]!.id };
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('GET /reviews', () => {
  it('returns the queue with a summary', async () => {
    const { assessmentId } = await seed();
    const response = await listRoute(new Request('http://localhost'), ctx(assessmentId));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.reviewCount).toBe(1);
    expect(body.reviews[0]).toMatchObject({ answerId: 'a-1', status: 'PENDING' });
    expect(body.summary).toMatchObject({ totalReviews: 1, pending: 1, resolved: 0 });
  });

  it('gives the frontend everything it needs to render a decision', async () => {
    const { assessmentId } = await seed();
    const body = await (
      await listRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    const item = body.reviews[0];

    expect(item.answer).toMatchObject({ id: 'a-1', text: 'Student answer a-1' });
    expect(item.answer.regions).toHaveLength(1);
    expect(item.aiMapping).toMatchObject({ questionId: Q1, confidenceBand: 'MEDIUM' });
    expect(item.candidates[0]).toMatchObject({
      questionId: Q1,
      questionText: 'Question Q1 text',
    });
    expect(item.effectiveMapping).toMatchObject({ questionId: Q1, source: 'AI' });
  });

  it('returns 400 for a malformed assessment id', async () => {
    const response = await listRoute(new Request('http://localhost'), ctx('../../etc/passwd'));
    expect(response.status).toBe(400);
  });
});

describe('GET /reviews/:reviewId', () => {
  it('returns one review item', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await detailRoute(
      new Request('http://localhost'),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(200);
    expect((await response.json()).reviewId).toBe(reviewId);
  });

  it('returns 404 for an unknown review', async () => {
    const { assessmentId } = await seed();
    const response = await detailRoute(
      new Request('http://localhost'),
      reviewCtx(assessmentId, UNKNOWN),
    );

    expect(response.status).toBe(404);
  });

  it('returns 400 for a malformed review id', async () => {
    const { assessmentId } = await seed();
    const response = await detailRoute(
      new Request('http://localhost'),
      reviewCtx(assessmentId, 'not-a-uuid'),
    );

    expect(response.status).toBe(400);
  });
});

describe('POST accept', () => {
  it('resolves the review and keeps the AI question in force', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await acceptRoute(
      post({ reviewerId: 'teacher-1' }),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.humanReview).toMatchObject({ status: 'RESOLVED', action: 'ACCEPT' });
    expect(body.effectiveMapping).toMatchObject({ questionId: Q1, source: 'HUMAN' });
    expect(body.changed).toBe(true);
  });

  it('reports a repeated accept as unchanged rather than erroring', async () => {
    const { assessmentId, reviewId } = await seed();

    await acceptRoute(post({}), reviewCtx(assessmentId, reviewId));
    const second = await acceptRoute(post({}), reviewCtx(assessmentId, reviewId));

    expect(second.status).toBe(200);
    expect((await second.json()).changed).toBe(false);
  });

  it('accepts an empty body', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await acceptRoute(post(null, ''), reviewCtx(assessmentId, reviewId));

    expect(response.status).toBe(200);
  });

  it('returns 400 for malformed JSON', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await acceptRoute(
      post(null, '{ not json'),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(400);
  });
});

describe('POST remap', () => {
  it('changes the effective question without touching the AI mapping', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await remapRoute(
      post({ questionId: Q2, reason: 'Answer belongs to Q2.' }),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body.aiMapping.questionId).toBe(Q1);
    expect(body.humanReview).toMatchObject({ action: 'REMAP', questionId: Q2 });
    expect(body.effectiveMapping).toMatchObject({ questionId: Q2, source: 'HUMAN' });
  });

  it('requires a questionId', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await remapRoute(post({}), reviewCtx(assessmentId, reviewId));

    expect(response.status).toBe(400);
  });

  it('rejects a non-UUID questionId', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await remapRoute(
      post({ questionId: 'q2' }),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 for a question outside this assessment', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await remapRoute(
      post({ questionId: UNKNOWN }),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(404);
  });

  it('returns a structured conflict when the question is already taken', async () => {
    const assessment = await createAssessment({ title: 'conflict' });
    const mappings = [mapping('a-1', Q1), mapping('a-2', Q2)];

    await store.update(assessment.id, (current) => ({
      ...current,
      questions: [question(Q1, 'Q1'), question(Q2, 'Q2')],
      answers: [answer('a-1'), answer('a-2')],
      mappings,
      reviews: buildReviewQueue(assessment.id, mappings, []),
    }));

    const stored = await getAssessment(assessment.id);
    const forA2 = stored.reviews.find((r) => r.answerId === 'a-2')!;

    const response = await remapRoute(
      post({ questionId: Q1 }),
      reviewCtx(assessment.id, forA2.id),
    );

    expect(response.status).toBe(409);

    const body = await response.json();
    expect(body.error.details).toMatchObject({
      code: 'QUESTION_ALREADY_ASSIGNED',
      questionId: Q1,
      existingAnswerId: 'a-1',
    });
  });

  it('rejects an over-long reason', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await remapRoute(
      post({ questionId: Q2, reason: 'x'.repeat(1001) }),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(400);
  });
});

describe('POST reject', () => {
  it('leaves the answer effectively unmapped', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await rejectRoute(
      post({ reason: 'Belongs to no question on this paper.' }),
      reviewCtx(assessmentId, reviewId),
    );

    const body = await response.json();
    expect(body.aiMapping.questionId).toBe(Q1);
    expect(body.effectiveMapping).toMatchObject({ questionId: null, source: 'HUMAN' });
  });
});

describe('POST skip', () => {
  it('leaves the item unresolved and the AI mapping in force', async () => {
    const { assessmentId, reviewId } = await seed();
    const response = await skipRoute(post({}), reviewCtx(assessmentId, reviewId));

    const body = await response.json();
    expect(body.humanReview).toMatchObject({ status: 'SKIPPED', action: 'SKIP' });
    expect(body.effectiveMapping).toMatchObject({ questionId: Q1, source: 'AI' });
  });
});

describe('resolved reviews', () => {
  it('refuses to change a decision already made', async () => {
    const { assessmentId, reviewId } = await seed();

    await acceptRoute(post({}), reviewCtx(assessmentId, reviewId));
    const response = await remapRoute(
      post({ questionId: Q2 }),
      reviewCtx(assessmentId, reviewId),
    );

    expect(response.status).toBe(409);
  });
});

describe('GET /mappings exposes all three layers', () => {
  it('shows the AI decision, the human decision and what is in force', async () => {
    const { assessmentId, reviewId } = await seed();

    await remapRoute(post({ questionId: Q2 }), reviewCtx(assessmentId, reviewId));

    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    const entry = body.mappings[0];

    expect(entry.aiMapping).toMatchObject({ questionId: Q1, confidence: 0.78 });
    expect(entry.humanReview).toMatchObject({ action: 'REMAP', questionId: Q2 });
    expect(entry.effectiveMapping).toMatchObject({ questionId: Q2, source: 'HUMAN' });
  });

  it('derives unmapped questions from the effective mappings, not the AI ones', async () => {
    const { assessmentId, reviewId } = await seed();

    await remapRoute(post({ questionId: Q2 }), reviewCtx(assessmentId, reviewId));

    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    // Q1 was the AI's choice but is no longer in force, so it is now free.
    expect(body.unmappedQuestionIds).toContain(Q1);
    expect(body.unmappedQuestionIds).not.toContain(Q2);
  });

  it('exposes no credentials or internal keys', async () => {
    const { assessmentId } = await seed();
    const raw = JSON.stringify(
      await (await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('GEMINI_API_KEY');
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain('veda-test:assessment');
  });

  it('exposes no grading', async () => {
    const { assessmentId } = await seed();
    const raw = JSON.stringify(
      await (await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('awarded');
    expect(raw).not.toContain('feedback');
  });
});
