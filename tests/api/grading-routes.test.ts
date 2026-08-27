import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { GET: gradesRoute } = await import('@/app/api/assessments/[assessmentId]/grades/route');
const { GET: gradeRoute } = await import(
  '@/app/api/assessments/[assessmentId]/grades/[questionId]/route'
);

const { gradeAssessment } = await import('@/lib/services/grading');
const { createAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { buildReviewQueue, remapReview, rejectReview } = await import('@/lib/services/review');
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { logger } = await import('@/lib/logger');
const { parseQuestionLabel } = await import('@/lib/domain/question');

import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';
import type { AnswerMapping } from '@/lib/domain/mapping';

const store = new InMemoryAssessmentStore();

const Q1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const Q2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const Q3 = 'a1b2c3d4-0000-4000-8000-000000000003';
const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555';

function listCtx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

function itemCtx(assessmentId: string, questionId: string) {
  return { params: Promise.resolve({ assessmentId, questionId }) };
}

function question(id: string, labelRaw: string, text: string, marks: number | null): Question {
  const parsed = parseQuestionLabel(labelRaw);

  return {
    id,
    labelRaw,
    normalizedLabel: parsed.normalizedLabel,
    sortKey: parsed.sortKey,
    parentLabel: parsed.parentLabel,
    isSubQuestion: parsed.isSubQuestion,
    text,
    marks,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
  };
}

function answer(id: string, text: string): Answer {
  return {
    id,
    claimedLabelRaw: null,
    claimedLabelNormalized: null,
    text,
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
    status: questionId === null ? 'UNMAPPED' : 'REVIEW_REQUIRED',
    confidence: questionId === null ? 0 : 0.78,
    confidenceBand: questionId === null ? 'LOW' : 'MEDIUM',
    signals: null,
    reasonCodes: [],
    candidates: [],
    verification: null,
    createdAt: '2026-01-01T00:00:00.000Z',
  };
}

const QUESTIONS = [
  question(Q1, 'Q1', 'Which organelle is primarily involved in photosynthesis?', 2),
  question(Q2, 'Q2', 'Describe the flow of blood through the human heart.', 3),
  question(Q3, 'Q3', 'Define osmosis and give one example.', 4),
];

async function seedAndGrade(): Promise<string> {
  const assessment = await createAssessment({ title: 'grading api' });
  const mappings = [mapping('a-1', Q1), mapping('a-2', Q2)];

  await store.update(assessment.id, (current) => ({
    ...current,
    questions: QUESTIONS,
    answers: [
      answer('a-1', 'The chloroplast is the organelle responsible.'),
      answer('a-2', 'Blood flows from the vena cava into the right atrium.'),
    ].map((entry, index) => ({ ...entry, documentPosition: index })),
    mappings,
    reviews: buildReviewQueue(assessment.id, mappings, []),
  }));

  await gradeAssessment({
    assessmentId: assessment.id,
    jobId: 'job-1',
    logger,
    provider: new FakeAIProvider({}),
  });

  return assessment.id;
}

async function reviewIdFor(assessmentId: string, answerId: string): Promise<string> {
  const assessment = await store.get(assessmentId);
  return assessment.reviews.find((review) => review.answerId === answerId)!.id;
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('GET /api/assessments/:assessmentId/grades', () => {
  it('returns every grade currently in force, with the marks that produced it', async () => {
    const assessmentId = await seedAndGrade();
    const response = await gradesRoute(new Request('http://test'), listCtx(assessmentId));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.gradeCount).toBe(2);
    expect(body.grades.map((grade: { questionId: string }) => grade.questionId).sort()).toEqual(
      [Q1, Q2],
    );
    expect(body.grades[0].criteria.length).toBeGreaterThan(0);
  });

  it('totals only the grades in force', async () => {
    const assessmentId = await seedAndGrade();
    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).json();

    // Full marks on Q1 (2) and Q2 (3), out of the five attempted.
    expect(body.summary).toMatchObject({
      awardedMarks: 5,
      availableMarks: 5,
      percentage: 100,
      totalAnswers: 2,
    });
  });

  it('reports the marks nobody accounted for separately from the percentage', async () => {
    const assessmentId = await seedAndGrade();
    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).json();

    // Q3 is worth 4 and no answer reached it.
    expect(body.summary.ungradedMarks).toBe(4);
    expect(body.summary.percentage).toBe(100);
  });

  it('puts what needs a human first', async () => {
    const assessmentId = await seedAndGrade();
    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).json();

    const statuses = body.grades.map((grade: { status: string }) => grade.status);

    expect(statuses[0]).toBe('REVIEW_REQUIRED');
  });

  it('says why a grade still wants a human', async () => {
    const assessmentId = await seedAndGrade();
    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).json();

    expect(body.grades[0].reviewReasons).toContain('GENERATED_RUBRIC');
    expect(body.grades[0].markScheme.source).toBe('GENERATED');
  });

  it('keeps a superseded grade out of the totals but visible as history', async () => {
    const assessmentId = await seedAndGrade();

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q3,
    });

    await gradeAssessment({
      assessmentId,
      jobId: 'job-2',
      logger,
      provider: new FakeAIProvider({}),
    });

    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).json();

    expect(body.gradeCount).toBe(2);
    expect(body.history).toHaveLength(1);
    expect(body.history[0]).toMatchObject({ questionId: Q1, awardedMarks: 2 });
    expect(body.history[0].supersededReason).toContain('effective question mapping changed');

    // The superseded two marks are not counted a second time.
    expect(body.summary.awardedMarks).toBe(7);
  });

  it('reports an answer a teacher rejected as not gradeable rather than as zero', async () => {
    const assessmentId = await seedAndGrade();

    await rejectReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      reason: 'Belongs to a different paper.',
    });

    await gradeAssessment({
      assessmentId,
      jobId: 'job-2',
      logger,
      provider: new FakeAIProvider({}),
    });

    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).json();

    const rejected = body.grades.find(
      (grade: { answerId: string }) => grade.answerId === 'a-1',
    );

    expect(rejected.status).toBe('NOT_GRADEABLE');
    expect(rejected.awardedMarks).toBeNull();
    expect(body.summary.awardedMarks).toBe(3);
  });

  it('is empty but well-formed before grading has run', async () => {
    const assessment = await createAssessment({ title: 'ungraded' });
    const body = await (
      await gradesRoute(new Request('http://test'), listCtx(assessment.id))
    ).json();

    expect(body.grades).toEqual([]);
    expect(body.history).toEqual([]);
    expect(body.grading).toBeNull();
    expect(body.summary.percentage).toBeNull();
  });

  it('rejects a malformed assessment id', async () => {
    const response = await gradesRoute(new Request('http://test'), listCtx('not-a-uuid'));

    expect(response.status).toBe(400);
  });

  it('404s for an assessment that does not exist', async () => {
    const response = await gradesRoute(new Request('http://test'), listCtx(UNKNOWN_ID));

    expect(response.status).toBe(404);
  });

  it('exposes no storage keys or provider credentials', async () => {
    const assessmentId = await seedAndGrade();
    const raw = await (
      await gradesRoute(new Request('http://test'), listCtx(assessmentId))
    ).text();

    expect(raw).not.toMatch(/api[_-]?key/i);
    expect(raw).not.toContain('veda-test');
    expect(raw).not.toMatch(/[A-Za-z]:\\\\/);
  });
});

describe('GET /api/assessments/:assessmentId/grades/:questionId', () => {
  it('returns the criterion breakdown and the rubric behind it', async () => {
    const assessmentId = await seedAndGrade();
    const body = await (
      await gradeRoute(new Request('http://test'), itemCtx(assessmentId, Q1))
    ).json();

    expect(body.question.labelRaw).toBe('Q1');
    expect(body.grade.awardedMarks).toBe(2);
    expect(body.grade.criteria[0]).toMatchObject({ outcome: 'SATISFIED', maximumMarks: 2 });
    expect(body.markScheme.totalMarks).toBe(2);
  });

  it('carries the answer that was marked, so the grade can be checked', async () => {
    const assessmentId = await seedAndGrade();
    const body = await (
      await gradeRoute(new Request('http://test'), itemCtx(assessmentId, Q1))
    ).json();

    expect(body.grade.answer).toMatchObject({
      id: 'a-1',
      text: 'The chloroplast is the organelle responsible.',
    });
  });

  it('says a question was not answered rather than failing', async () => {
    const assessmentId = await seedAndGrade();
    const response = await gradeRoute(new Request('http://test'), itemCtx(assessmentId, Q3));
    const body = await response.json();

    expect(response.status).toBe(200);
    expect(body.grade).toBeNull();
    expect(body.markScheme.totalMarks).toBe(4);
  });

  it('shows a grade this question used to hold after an answer moved away', async () => {
    const assessmentId = await seedAndGrade();

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q3,
    });

    await gradeAssessment({
      assessmentId,
      jobId: 'job-2',
      logger,
      provider: new FakeAIProvider({}),
    });

    const previous = await (
      await gradeRoute(new Request('http://test'), itemCtx(assessmentId, Q1))
    ).json();

    expect(previous.grade).toBeNull();
    expect(previous.history).toHaveLength(1);
    expect(previous.history[0]).toMatchObject({ answerId: 'a-1', awardedMarks: 2 });

    const moved = await (
      await gradeRoute(new Request('http://test'), itemCtx(assessmentId, Q3))
    ).json();

    expect(moved.grade.answerId).toBe('a-1');
    expect(moved.grade.mappingSource).toBe('HUMAN');
  });

  it('404s for a question id belonging to another assessment', async () => {
    const first = await seedAndGrade();
    const second = await createAssessment({ title: 'other' });

    // A well-formed id, valid elsewhere, is not readable through this
    // assessment.
    const response = await gradeRoute(
      new Request('http://test'),
      itemCtx(second.id, Q1),
    );

    expect(response.status).toBe(404);
    expect(first).not.toBe(second.id);
  });

  it('rejects a malformed question id', async () => {
    const assessmentId = await seedAndGrade();
    const response = await gradeRoute(
      new Request('http://test'),
      itemCtx(assessmentId, 'not-a-uuid'),
    );

    expect(response.status).toBe(400);
  });

  it('404s for an assessment that does not exist', async () => {
    const response = await gradeRoute(new Request('http://test'), itemCtx(UNKNOWN_ID, Q1));

    expect(response.status).toBe(404);
  });
});
