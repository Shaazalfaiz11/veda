import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { gradeAssessment } = await import('@/lib/services/grading');
const { createAssessment, getAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { buildReviewQueue, rejectReview, remapReview } = await import('@/lib/services/review');
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { DependencyUnavailableError } = await import('@/lib/errors');
const { logger } = await import('@/lib/logger');
const { parseQuestionLabel } = await import('@/lib/domain/question');

import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';
import type { AnswerMapping } from '@/lib/domain/mapping';
import type { GradingRequest, GradingResult } from '@/lib/providers/ai';

const store = new InMemoryAssessmentStore();

type Fake = InstanceType<typeof FakeAIProvider>;

const Q1 = 'a1b2c3d4-0000-4000-8000-000000000001';
const Q2 = 'a1b2c3d4-0000-4000-8000-000000000002';
const Q3 = 'a1b2c3d4-0000-4000-8000-000000000003';
const Q4 = 'a1b2c3d4-0000-4000-8000-000000000004';

function question(
  id: string,
  labelRaw: string,
  text: string,
  marks: number | null,
): Question {
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

function answer(id: string, text: string, overrides: Partial<Answer> = {}): Answer {
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
    ...overrides,
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
  // Prints no marks: there is nothing to grade this one against.
  question(Q3, 'Q3', 'Comment on the experiment.', null),
  // Unanswered in the default fixture, so a remap has somewhere free to go.
  question(Q4, 'Q4', 'Define osmosis and give one example.', 4),
];

interface SeedOptions {
  answers?: Answer[];
  mappings?: AnswerMapping[];
  withReviews?: boolean;
}

async function seed(options: SeedOptions = {}): Promise<string> {
  const answers = options.answers ?? [
    answer('a-1', 'The chloroplast is the organelle responsible.'),
    answer('a-2', 'Blood flows from the vena cava into the right atrium.'),
  ];
  const mappings = options.mappings ?? [mapping('a-1', Q1), mapping('a-2', Q2)];

  const assessment = await createAssessment({ title: 'grading' });

  await store.update(assessment.id, (current) => ({
    ...current,
    questions: QUESTIONS,
    answers: answers.map((entry, index) => ({ ...entry, documentPosition: index })),
    mappings,
    reviews:
      options.withReviews === false
        ? []
        : buildReviewQueue(assessment.id, mappings, []),
  }));

  return assessment.id;
}

function run(assessmentId: string, provider: Fake) {
  return gradeAssessment({ assessmentId, jobId: 'job-1', logger, provider });
}

/** The current grade for one answer, which is what a run is judged by. */
function gradeFor(outcome: Awaited<ReturnType<typeof run>>, answerId: string) {
  return outcome.grades.find((grade) => grade.answerId === answerId && grade.isCurrent)!;
}

/** A response that awards `awarded` on the single generated criterion. */
function award(awarded: number): (request: GradingRequest) => GradingResult {
  return (request) => ({
    criteria: request.criteria.map((criterion) => ({
      criterionId: criterion.id,
      awardedMarks: awarded,
      reason: 'Partly right.',
    })),
    totalAwardedMarks: awarded * request.criteria.length,
    confidence: 0.9,
    feedback: 'Reasonable attempt.',
    usage: null,
  });
}

async function reviewIdFor(assessmentId: string, answerId: string): Promise<string> {
  const assessment = await getAssessment(assessmentId);
  return assessment.reviews.find((review) => review.answerId === answerId)!.id;
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('grading against the effective mapping', () => {
  it('grades every mapped answer and computes the total itself', async () => {
    const provider = new FakeAIProvider({});
    const outcome = await run(await seed(), provider);

    const grades = outcome.grades.filter((grade) => grade.isCurrent);

    expect(provider.gradeCalls).toBe(2);
    expect(grades.map((g) => [g.questionId, g.awardedMarks, g.maximumMarks])).toEqual([
      [Q1, 2, 2],
      [Q2, 3, 3],
    ]);
  });

  it('sends one question and one answer per call, never the whole paper', async () => {
    const seen: GradingRequest[] = [];
    const provider = new FakeAIProvider({ onGrade: (request) => seen.push(request) });

    await run(await seed(), provider);

    expect(seen).toHaveLength(2);
    expect(seen[0]!.questionText).toBe(QUESTIONS[0]!.text);
    expect(seen[0]!.answerText).toBe('The chloroplast is the organelle responsible.');
    // Nothing from the other question or the other answer leaks into the call.
    expect(JSON.stringify(seen[0])).not.toContain('vena cava');
    expect(JSON.stringify(seen[0])).not.toContain(QUESTIONS[1]!.text);
  });

  it('grades against the teacher’s question after a remap, not the AI’s', async () => {
    const assessmentId = await seed();

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q3,
      reviewerId: 'teacher-1',
    });

    const seen: GradingRequest[] = [];
    const provider = new FakeAIProvider({ onGrade: (request) => seen.push(request) });

    const outcome = await run(assessmentId, provider);
    const forA1 = outcome.grades.find((grade) => grade.answerId === 'a-1' && grade.isCurrent)!;

    // Q3 prints no marks, so there is nothing to grade it against — but the
    // point stands: the grade is attached to the teacher's question, and the
    // AI's Q1 is never marked.
    expect(forA1.questionId).toBe(Q3);
    expect(seen.some((request) => request.questionText === QUESTIONS[0]!.text)).toBe(false);
  });

  it('grades against a remapped question that does have a mark scheme', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'Blood flows from the vena cava into the right atrium.')],
      mappings: [mapping('a-1', Q1)],
    });

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q2,
    });

    const provider = new FakeAIProvider({});
    const outcome = await run(assessmentId, provider);
    const grade = outcome.grades.find((g) => g.isCurrent)!;

    expect(grade.questionId).toBe(Q2);
    // Marked out of Q2's three marks, not Q1's two.
    expect(grade.maximumMarks).toBe(3);
    expect(provider.lastGrading?.questionText).toBe(QUESTIONS[1]!.text);
  });

  it('does not grade an answer whose mapping a teacher rejected', async () => {
    const assessmentId = await seed();

    await rejectReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      reason: 'Not an answer to any question on this paper.',
    });

    const provider = new FakeAIProvider({});
    const outcome = await run(assessmentId, provider);
    const forA1 = outcome.grades.find((grade) => grade.answerId === 'a-1')!;

    expect(forA1.status).toBe('NOT_GRADEABLE');
    expect(forA1.notGradeableReason).toBe('NO_EFFECTIVE_QUESTION_MAPPING');
    expect(forA1.awardedMarks).toBeNull();
    // Only the other answer reached the model.
    expect(provider.gradeCalls).toBe(1);
  });

  it('records no marks at all for an ungraded answer, rather than zero', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'Something.')],
      mappings: [mapping('a-1', null)],
    });

    const outcome = await run(assessmentId, new FakeAIProvider({}));

    expect(outcome.grades[0]!.awardedMarks).toBeNull();
    expect(outcome.grades[0]!.maximumMarks).toBeNull();
  });

  it('does not grade an answer that has no mapping record at all', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'Orphaned answer.')],
      mappings: [],
    });

    const provider = new FakeAIProvider({});
    const outcome = await run(assessmentId, provider);

    expect(outcome.grades[0]!.notGradeableReason).toBe('NO_EFFECTIVE_QUESTION_MAPPING');
    expect(provider.gradeCalls).toBe(0);
  });

  it('refuses to grade a question that prints no marks rather than inventing a rubric', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'Some commentary.')],
      mappings: [mapping('a-1', Q3)],
    });

    const provider = new FakeAIProvider({});
    const outcome = await run(assessmentId, provider);

    expect(outcome.grades[0]!.status).toBe('NOT_GRADEABLE');
    expect(outcome.grades[0]!.notGradeableReason).toBe('MARK_SCHEME_UNAVAILABLE');
    expect(outcome.grades[0]!.questionId).toBe(Q3);
    expect(provider.gradeCalls).toBe(0);
  });
});

describe('what the model returns is checked, not trusted', () => {
  it('rejects a total that disagrees with its own criteria', async () => {
    const provider = new FakeAIProvider({
      grading: (request) => ({
        criteria: request.criteria.map((criterion) => ({
          criterionId: criterion.id,
          awardedMarks: 1,
          reason: 'One point made.',
        })),
        // Says 2 while awarding 1.
        totalAwardedMarks: 2,
        confidence: 0.9,
        feedback: 'Fine.',
        usage: null,
      }),
    });

    const outcome = await run(await seed(), provider);

    expect(gradeFor(outcome, 'a-1').status).toBe('FAILED');
    expect(gradeFor(outcome, 'a-1').feedback).toMatch(/internally inconsistent/);
    expect(gradeFor(outcome, 'a-1').awardedMarks).toBeNull();
  });

  it('rejects a criterion id that was never in the rubric', async () => {
    const provider = new FakeAIProvider({
      grading: {
        criteria: [{ criterionId: 'invented', awardedMarks: 1, reason: 'made up' }],
        totalAwardedMarks: 1,
        confidence: 0.9,
        feedback: 'Fine.',
        usage: null,
      },
    });

    const outcome = await run(await seed(), provider);

    expect(gradeFor(outcome, 'a-1').status).toBe('FAILED');
    expect(gradeFor(outcome, 'a-1').feedback).toMatch(/not in the mark scheme/);
  });

  it('rejects marks above what the criterion is worth', async () => {
    const provider = new FakeAIProvider({ grading: award(9) });

    const outcome = await run(await seed(), provider);

    expect(gradeFor(outcome, 'a-1').status).toBe('FAILED');
    expect(gradeFor(outcome, 'a-1').feedback).toMatch(/at most/);
  });

  it('does not silently cap an over-award', async () => {
    const provider = new FakeAIProvider({ grading: award(9) });
    const assessmentId = await seed();

    await run(assessmentId, provider);

    // No repaired grade was written in place of the rejected one: the answer
    // is unmarked, not marked down to the ceiling the model overshot.
    for (const grade of (await getAssessment(assessmentId)).grades) {
      expect(grade.status).toBe('FAILED');
      expect(grade.awardedMarks).toBeNull();
    }
  });

  it('rejects a response that leaves a criterion unjudged', async () => {
    const provider = new FakeAIProvider({
      grading: {
        criteria: [],
        totalAwardedMarks: 0,
        confidence: 0.9,
        feedback: 'Nothing to say.',
        usage: null,
      },
    });

    const outcome = await run(await seed(), provider);

    expect(gradeFor(outcome, 'a-1').status).toBe('FAILED');
    expect(gradeFor(outcome, 'a-1').feedback).toMatch(/did not judge every criterion/);
  });

  it('rejects a criterion judged twice', async () => {
    const provider = new FakeAIProvider({
      grading: (request) => {
        const id = request.criteria[0]!.id;

        return {
          criteria: [
            { criterionId: id, awardedMarks: 1, reason: 'once' },
            { criterionId: id, awardedMarks: 1, reason: 'twice' },
          ],
          totalAwardedMarks: 2,
          confidence: 0.9,
          feedback: 'Fine.',
          usage: null,
        };
      },
    });

    const outcome = await run(await seed(), provider);

    expect(gradeFor(outcome, 'a-1').status).toBe('FAILED');
    expect(gradeFor(outcome, 'a-1').feedback).toMatch(/more than once/);
  });

  /*
   * A rejected recommendation used to abandon the stage, taking every grade
   * already computed on the paper with it. The rejection still stands -- no
   * marks are written for the answer it came from -- but it is now that
   * answer's outcome rather than the run's.
   */
  it('records the failure against the answer and still grades the rest', async () => {
    const assessmentId = await seed();

    const provider = new FakeAIProvider({
      grading: (request) =>
        request.questionLabel === 'Q1'
          ? {
              criteria: [{ criterionId: 'invented', awardedMarks: 1, reason: 'made up' }],
              totalAwardedMarks: 1,
              confidence: 0.9,
              feedback: 'Fine.',
              usage: null,
            }
          : award(1)(request),
    });

    const outcome = await run(assessmentId, provider);
    const stored = await getAssessment(assessmentId);

    expect(gradeFor(outcome, 'a-1').status).toBe('FAILED');
    expect(gradeFor(outcome, 'a-1').awardedMarks).toBeNull();

    // The other answer was marked normally rather than lost with it.
    expect(gradeFor(outcome, 'a-2').awardedMarks).toBe(1);

    expect(stored.grading).not.toBeNull();
    expect(stored.grades).toHaveLength(2);
  });

  it('derives each criterion outcome from the marks rather than the model’s claim', async () => {
    const provider = new FakeAIProvider({ grading: award(1) });
    const outcome = await run(await seed(), provider);

    const forQ1 = outcome.grades.find((grade) => grade.questionId === Q1)!;

    // One of two marks: partial, whatever the model said about it.
    expect(forQ1.criteria[0]!.outcome).toBe('PARTIAL');
    expect(forQ1.awardedMarks).toBe(1);
  });

  it('records a provider failure rather than a zero', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      gradingError: new DependencyUnavailableError('Groq is unavailable.'),
    });

    const outcome = await run(assessmentId, provider);

    for (const answerId of ['a-1', 'a-2']) {
      const grade = gradeFor(outcome, answerId);

      expect(grade.status).toBe('FAILED');
      // The distinction the status exists to make: unmarked, not marked zero.
      expect(grade.awardedMarks).toBeNull();
      expect(grade.feedback).toMatch(/could not be marked automatically/);
    }

    // A FAILED grade is not reused, so a later run marks these answers again.
    const stored = await getAssessment(assessmentId);
    expect(stored.grades.every((g) => g.status === 'FAILED')).toBe(true);
  });
});

describe('uncertainty is carried through', () => {
  it('tells the grader when the transcription could not be read, and flags the result', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'The [unclear] is responsible.', { hasUncertainSegments: true })],
      mappings: [mapping('a-1', Q1)],
    });

    const provider = new FakeAIProvider({});
    const outcome = await run(assessmentId, provider);

    expect(provider.lastGrading?.answerHasUncertainSegments).toBe(true);
    expect(outcome.grades[0]!.reviewReasons).toContain('UNCERTAIN_TRANSCRIPTION');
    expect(outcome.grades[0]!.status).toBe('REVIEW_REQUIRED');
  });

  it('an illegible answer is graded on what is legible, not marked wrong', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'The [unclear] is responsible.', { hasUncertainSegments: true })],
      mappings: [mapping('a-1', Q1)],
    });

    const outcome = await run(assessmentId, new FakeAIProvider({}));

    expect(outcome.grades[0]!.awardedMarks).toBe(2);
    expect(outcome.grades[0]!.status).not.toBe('NOT_GRADEABLE');
  });

  it('tells the grader when the answer contains a drawing it cannot see', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'See diagram.', { containsDiagram: true })],
      mappings: [mapping('a-1', Q1)],
    });

    const provider = new FakeAIProvider({});
    await run(assessmentId, provider);

    expect(provider.lastGrading?.answerContainsDiagram).toBe(true);
  });

  it('flags a drawing the question actually asked for', async () => {
    const assessmentId = await seed({
      answers: [answer('a-1', 'See diagram.', { containsDiagram: true })],
      mappings: [mapping('a-1', Q2)],
    });

    await store.update(assessmentId, (current) => ({
      ...current,
      questions: current.questions.map((entry) =>
        entry.id === Q2 ? { ...entry, text: 'Draw and label the human heart.' } : entry,
      ),
    }));

    const outcome = await run(assessmentId, new FakeAIProvider({}));

    expect(outcome.grades[0]!.reviewReasons).toContain('DIAGRAM_NOT_ASSESSABLE');
  });

  it('says the rubric was derived rather than supplied', async () => {
    const outcome = await run(await seed(), new FakeAIProvider({}));

    expect(outcome.grades[0]!.reviewReasons).toContain('GENERATED_RUBRIC');
    expect(outcome.grades[0]!.metadata?.markSchemeSource).toBe('GENERATED');
  });
});

describe('idempotency and history', () => {
  it('makes no further calls when nothing about the mapping changed', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({});

    await run(assessmentId, provider);
    const second = await run(assessmentId, provider);

    expect(provider.gradeCalls).toBe(2);
    expect(second.reused).toBe(true);
  });

  it('re-grades only the answer a teacher remapped', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({});

    await run(assessmentId, provider);

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q4,
    });
    await run(assessmentId, provider);

    // Two calls for the first run, one for the answer that moved. The
    // untouched answer is not paid for twice.
    expect(provider.gradeCalls).toBe(3);
  });

  it('keeps the superseded grade instead of overwriting it', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({});

    await run(assessmentId, provider);
    const original = (await getAssessment(assessmentId)).grades.find(
      (grade) => grade.answerId === 'a-1',
    )!;

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q4,
    });
    await run(assessmentId, provider);

    const stored = await getAssessment(assessmentId);
    const history = stored.grades.filter((grade) => grade.answerId === 'a-1');

    expect(history).toHaveLength(2);

    const old = history.find((grade) => grade.id === original.id)!;
    const current = history.find((grade) => grade.isCurrent)!;

    expect(old.isCurrent).toBe(false);
    expect(old.questionId).toBe(Q1);
    expect(old.awardedMarks).toBe(original.awardedMarks);
    expect(old.supersededReason).toContain('effective question mapping changed');

    expect(current.questionId).toBe(Q4);
    expect(current.maximumMarks).toBe(4);
    expect(current.id).not.toBe(original.id);
  });

  it('leaves exactly one current grade per answer', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({});

    await run(assessmentId, provider);
    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q3,
    });
    await run(assessmentId, provider);

    const stored = await getAssessment(assessmentId);
    const currentPerAnswer = stored.grades.filter((grade) => grade.isCurrent);

    expect(currentPerAnswer).toHaveLength(2);
    expect(new Set(currentPerAnswer.map((grade) => grade.answerId)).size).toBe(2);
  });

  it('keeps the earlier grades when a later run fails', async () => {
    const assessmentId = await seed();

    await run(assessmentId, new FakeAIProvider({}));
    const before = (await getAssessment(assessmentId)).grades;

    await remapReview({
      assessmentId,
      reviewId: await reviewIdFor(assessmentId, 'a-1'),
      questionId: Q4,
    });

    await run(
      assessmentId,
      new FakeAIProvider({ gradingError: new DependencyUnavailableError('down') }),
    );

    const after = (await getAssessment(assessmentId)).grades;

    // The remapped answer is the only one re-graded, so it is the only one
    // that can fail. Its old grade was made against the question the teacher
    // overruled, so it is superseded rather than left standing as current --
    // but it is kept, which is what makes the mark auditable.
    const failed = after.find((g) => g.answerId === 'a-1' && g.isCurrent)!;
    expect(failed.status).toBe('FAILED');
    expect(failed.awardedMarks).toBeNull();

    const superseded = after.find((g) => g.answerId === 'a-1' && !g.isCurrent)!;
    expect(superseded).toBeDefined();
    expect(superseded.awardedMarks).toBe(before.find((g) => g.answerId === 'a-1')!.awardedMarks);

    // Every other answer kept the grade it already had.
    for (const grade of before.filter((g) => g.answerId !== 'a-1')) {
      expect(after).toContainEqual(grade);
    }
  });
});

describe('provenance', () => {
  it('records the rubric and prompt each grade was made against', async () => {
    const outcome = await run(await seed(), new FakeAIProvider({}));
    const grade = outcome.grades[0]!;

    expect(grade.metadata).toMatchObject({
      provider: 'fake',
      promptVersion: 'grading/v1',
      algorithmVersion: 'grading/v1',
      markSchemeSource: 'GENERATED',
    });
    expect(grade.metadata?.markSchemeVersion).toMatch(/^[0-9a-f]{16}$/);
  });

  it('records what the run did', async () => {
    const { metadata } = await run(await seed(), new FakeAIProvider({}));

    expect(metadata).toMatchObject({
      answersConsidered: 2,
      gradingCalls: 2,
      notGradeable: 0,
      markSchemeSource: 'GENERATED',
    });
  });

  it('stores the resolved mark schemes alongside the grades', async () => {
    const assessmentId = await seed();
    await run(assessmentId, new FakeAIProvider({}));

    const stored = await getAssessment(assessmentId);

    // Q3 prints no marks, so it gets no scheme at all.
    expect(stored.markSchemes?.schemes.map((scheme) => scheme.questionId)).toEqual([Q1, Q2, Q4]);
  });

  it('leaks no provider credentials into stored state', async () => {
    const assessmentId = await seed();
    await run(assessmentId, new FakeAIProvider({}));

    const raw = JSON.stringify(await getAssessment(assessmentId));

    expect(raw).not.toMatch(/api[_-]?key/i);
    expect(raw).not.toContain('GEMINI');
  });
});
