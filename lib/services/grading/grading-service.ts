import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import { getEnv } from '@/lib/config';
import { ValidationError, isAppError } from '@/lib/errors';
import type { Assessment } from '@/lib/domain/assessment';
import type { Answer } from '@/lib/domain/answer';
import type { Question } from '@/lib/domain/question';
import { resolveEffectiveMapping } from '@/lib/domain/review';
import {
  GRADING_ALGORITHM_VERSION,
  calculateAwardedMarks,
  calculateGradingConfidence,
  outcomeForMarks,
  resolveGradingStatus,
  validateCriterionMarks,
  validateTotalMarks,
  verifyCriterionTotal,
  type CriterionGrade,
  type GradingResult,
  type GradingRunMetadata,
  type MarkScheme,
  type MarkSchemeSet,
  type NotGradeableReason,
} from '@/lib/domain/grading';
import {
  GRADING_PROMPT_VERSION,
  type AIProvider,
  type GradingResult as ProviderGradingResult,
} from '@/lib/providers/ai';
import { getAssessmentStore } from '@/lib/services/assessment-store';
import { assertUsableMarkScheme, findMarkScheme, resolveMarkSchemes } from './mark-scheme-service';

/**
 * Grading.
 *
 * Marks each answer against the question it *effectively* belongs to — the
 * Phase 6 resolution, so a teacher's correction is what gets graded, never
 * the AI's superseded guess.
 *
 * The model produces a criterion-by-criterion recommendation. This service
 * decides what it is worth: every criterion id is checked against the rubric
 * that was actually sent, every mark against its ceiling, and the total is
 * computed here rather than read from the response. A grade that survives all
 * of that is still only applied unattended if the confidence supports it.
 */

export interface GradingContext {
  assessmentId: string;
  jobId: string;
  logger: Logger;
  provider: AIProvider;
}

export interface GradingOutcome {
  grades: GradingResult[];
  metadata: GradingRunMetadata;
  reused: boolean;
}

function now(): string {
  return new Date().toISOString();
}

export async function gradeAssessment(context: GradingContext): Promise<GradingOutcome> {
  const { assessmentId, provider, logger } = context;
  const env = getEnv();

  const store = getAssessmentStore();
  const assessment = await store.get(assessmentId);

  const log = logger.child({ provider: provider.name, model: provider.model });

  // Every answer is graded against the question currently in force for it.
  const targets = resolveGradingTargets(assessment);

  // Records written before this phase have no grades array at all; the store
  // casts rather than validates, so treat a missing one as empty.
  const priorGrades = assessment.grades ?? [];

  // Within-run reuse. Keyed on the effective question, so a remap genuinely
  // re-grades while an unchanged answer costs nothing on a retry.
  const existing = priorGrades.filter((grade) => grade.isCurrent);
  const stillValid = existing.filter((grade) =>
    targets.some(
      (target) => target.answerId === grade.answerId && target.questionId === grade.questionId,
    ),
  );

  if (existing.length > 0 && stillValid.length === existing.length && assessment.grading) {
    log.info(
      { status: 'REUSED', gradeCount: existing.length },
      'assessment.grading.reused',
    );

    return { grades: priorGrades, metadata: assessment.grading, reused: true };
  }

  const markSchemes = resolveMarkSchemes({
    questions: assessment.questions,
    granularity: env.GRADING_MARK_GRANULARITY,
  });

  log.info(
    {
      status: 'STARTED',
      answerCount: targets.length,
      markSchemeCount: markSchemes.schemes.length,
    },
    'assessment.grading.started',
  );

  const started = Date.now();
  const fresh: GradingResult[] = [];
  let gradingCalls = 0;

  for (const target of targets) {
    // Reuse an existing current grade for an unchanged pairing rather than
    // paying for it again.
    const reusable = existing.find(
      (grade) =>
        grade.answerId === target.answerId &&
        grade.questionId === target.questionId &&
        grade.status !== 'FAILED',
    );

    if (reusable) {
      fresh.push(reusable);
      continue;
    }

    if (target.notGradeableReason) {
      fresh.push(notGradeable(assessmentId, target.answerId, target.notGradeableReason));
      continue;
    }

    const scheme = findMarkScheme(markSchemes, target.questionId!);

    if (!scheme) {
      // No printed marks and no supplied scheme: there is nothing to grade
      // against, and inventing a mark total would fabricate the measure.
      fresh.push(
        notGradeable(assessmentId, target.answerId, 'MARK_SCHEME_UNAVAILABLE', target.questionId),
      );
      continue;
    }

    if (gradingCalls > 0 && env.GRADING_CALL_DELAY_MS > 0) {
      // Pacing, not retrying: constrained tiers reject a burst they would
      // accept spread out. Retry remains the queue's job.
      await delay(env.GRADING_CALL_DELAY_MS);
    }

    gradingCalls += 1;
    fresh.push(await gradeOne(assessmentId, target, scheme, provider, log));
  }

  // Previous grades are superseded, never deleted: a remap produces a new
  // grade beside the old one so the history stays readable.
  const superseded = supersede(priorGrades, fresh);

  const metadata: GradingRunMetadata = {
    provider: provider.name,
    model: provider.model,
    promptVersion: GRADING_PROMPT_VERSION,
    algorithmVersion: GRADING_ALGORITHM_VERSION,
    gradedAt: now(),
    answersConsidered: targets.length,
    answersGraded: fresh.filter((g) => g.status === 'GRADED').length,
    notGradeable: fresh.filter((g) => g.status === 'NOT_GRADEABLE').length,
    reviewRequired: fresh.filter((g) => g.status === 'REVIEW_REQUIRED').length,
    gradingCalls,
    markSchemeSource: markSchemes.source,
  };

  await persist(assessmentId, [...superseded, ...fresh], markSchemes, metadata);

  log.info(
    {
      status: 'COMPLETED',
      answerCount: targets.length,
      graded: metadata.answersGraded,
      reviewRequired: metadata.reviewRequired,
      notGradeable: metadata.notGradeable,
      gradingCalls,
      supersededCount: superseded.filter((g) => !g.isCurrent).length -
        priorGrades.filter((g) => !g.isCurrent).length,
      durationMs: Date.now() - started,
    },
    'assessment.grading.completed',
  );

  return { grades: [...superseded, ...fresh], metadata, reused: false };
}

interface GradingTarget {
  answerId: string;
  questionId: string | null;
  answer: Answer;
  question: Question | null;
  notGradeableReason: NotGradeableReason | null;
}

/**
 * Works out what to grade, and against what.
 *
 * The effective mapping is the only input that decides the question. An
 * answer a teacher rejected has no effective question and is not graded
 * against the AI's discarded guess — doing so would mark a student against a
 * question a human already said was wrong.
 */
function resolveGradingTargets(assessment: Assessment): GradingTarget[] {
  const reviewByAnswerId = new Map(
    (assessment.reviews ?? []).map((review) => [review.answerId, review]),
  );
  const questionById = new Map(assessment.questions.map((q) => [q.id, q]));

  return assessment.answers.map((answer) => {
    const mapping = assessment.mappings.find((m) => m.answerId === answer.id);

    if (!mapping) {
      return {
        answerId: answer.id,
        questionId: null,
        answer,
        question: null,
        notGradeableReason: 'NO_EFFECTIVE_QUESTION_MAPPING' as const,
      };
    }

    const effective = resolveEffectiveMapping(
      mapping,
      reviewByAnswerId.get(answer.id) ?? null,
    );

    if (effective.questionId === null) {
      return {
        answerId: answer.id,
        questionId: null,
        answer,
        question: null,
        notGradeableReason: 'NO_EFFECTIVE_QUESTION_MAPPING' as const,
      };
    }

    const question = questionById.get(effective.questionId) ?? null;

    return {
      answerId: answer.id,
      questionId: effective.questionId,
      answer,
      question,
      notGradeableReason: question ? null : ('QUESTION_NOT_FOUND' as const),
    };
  });
}

/** Marks one answer, then decides what the recommendation is worth. */
async function gradeOne(
  assessmentId: string,
  target: GradingTarget,
  scheme: MarkScheme,
  provider: AIProvider,
  log: Logger,
): Promise<GradingResult> {
  const question = target.question!;
  const answer = target.answer;

  assertUsableMarkScheme(scheme);

  let recommendation: ProviderGradingResult;

  try {
    recommendation = await provider.gradeAnswer({
      questionLabel: question.labelRaw,
      questionText: question.text,
      parentContext: null,
      totalMarks: scheme.totalMarks,
      granularity: scheme.granularity,
      answerText: answer.text,
      answerHasUncertainSegments: answer.hasUncertainSegments,
      answerContainsDiagram: answer.containsDiagram,
      criteria: scheme.criteria.map((criterion) => ({
        id: criterion.id,
        description: criterion.description,
        maxMarks: criterion.maxMarks,
        acceptableConcepts: criterion.acceptableConcepts,
        allowsPartialCredit: criterion.allowsPartialCredit,
      })),
      modelAnswer: scheme.modelAnswer,
      rubricIsGenerated: scheme.source === 'GENERATED',
    });
  } catch (error) {
    log.error(
      {
        answerId: answer.id,
        questionId: question.id,
        status: 'FAILED',
        code: isAppError(error) ? error.code : 'UNKNOWN',
        retryable: isAppError(error) ? error.retryable : true,
        // The provider attaches what separates one failure from another — the
        // HTTP status behind an unavailable provider, the finish reason behind
        // unparseable JSON. Without it the code is the only clue, and the code
        // is the part already obvious from the message.
        detail: isAppError(error) ? error.details : undefined,
      },
      'assessment.grading.failed',
    );
    throw error;
  }

  const criteria = verifyRecommendation(recommendation, scheme);
  const awardedMarks = calculateAwardedMarks(criteria);

  validateTotalMarks(awardedMarks, scheme);

  const questionExpectsDiagram = /\b(draw|sketch|diagram|label|illustrate|plot)\b/i.test(
    question.text,
  );

  const { confidence, factors } = calculateGradingConfidence({
    scheme,
    answerHasUncertainSegments: answer.hasUncertainSegments,
    answerContainsDiagram: answer.containsDiagram,
    questionExpectsDiagram,
    modelConfidence: recommendation.confidence,
    criteria,
  });

  const { status, reviewReasons } = resolveGradingStatus({
    confidence,
    scheme,
    answerHasUncertainSegments: answer.hasUncertainSegments,
    answerContainsDiagram: answer.containsDiagram,
    questionExpectsDiagram,
  });

  log.info(
    {
      answerId: answer.id,
      questionId: question.id,
      status,
      awardedMarks,
      maximumMarks: scheme.totalMarks,
      confidence,
      reviewReasons,
    },
    'assessment.grading.graded',
  );

  return {
    id: randomUUID(),
    assessmentId,
    questionId: question.id,
    answerId: answer.id,
    status,
    awardedMarks,
    maximumMarks: scheme.totalMarks,
    criteria,
    confidence,
    confidenceFactors: factors,
    feedback: recommendation.feedback.trim(),
    notGradeableReason: null,
    reviewReasons,
    metadata: {
      provider: provider.name,
      model: provider.model,
      promptVersion: GRADING_PROMPT_VERSION,
      markSchemeVersion: scheme.version,
      markSchemeSource: scheme.source,
      algorithmVersion: GRADING_ALGORITHM_VERSION,
      gradedAt: now(),
    },
    isCurrent: true,
    supersededReason: null,
    createdAt: now(),
  };
}

/**
 * Checks a recommendation against the rubric it was made from.
 *
 * Three things no schema could catch: that every id was one we supplied, that
 * every criterion was actually judged, and that the model's own total agrees
 * with its own criteria. A failure here is thrown rather than repaired —
 * a grader whose arithmetic contradicts itself was not reasoning reliably
 * about this answer, so its per-criterion marks are no more trustworthy than
 * the total it derived from them.
 */
function verifyRecommendation(
  recommendation: ProviderGradingResult,
  scheme: MarkScheme,
): CriterionGrade[] {
  const byId = new Map(scheme.criteria.map((criterion) => [criterion.id, criterion]));
  const seen = new Set<string>();
  const criteria: CriterionGrade[] = [];

  for (const entry of recommendation.criteria) {
    const criterion = byId.get(entry.criterionId);

    if (!criterion) {
      throw new ValidationError(
        `Grading cited criterion "${entry.criterionId}", which is not in the mark scheme.`,
        { criterionId: entry.criterionId, expected: [...byId.keys()] },
      );
    }

    if (seen.has(entry.criterionId)) {
      throw new ValidationError(
        `Grading cited criterion "${entry.criterionId}" more than once.`,
        { criterionId: entry.criterionId },
      );
    }

    seen.add(entry.criterionId);
    validateCriterionMarks(entry.awardedMarks, criterion, scheme);

    criteria.push({
      criterionId: criterion.id,
      description: criterion.description,
      awardedMarks: entry.awardedMarks,
      maximumMarks: criterion.maxMarks,
      // Derived from the marks rather than taken on the model's word.
      outcome: outcomeForMarks(entry.awardedMarks, criterion.maxMarks),
      reason: entry.reason.trim(),
    });
  }

  const missing = scheme.criteria.filter((criterion) => !seen.has(criterion.id));

  if (missing.length > 0) {
    throw new ValidationError(
      `Grading did not judge every criterion; missing: ${missing.map((c) => c.id).join(', ')}.`,
      { missing: missing.map((c) => c.id) },
    );
  }

  verifyCriterionTotal(criteria, recommendation.totalAwardedMarks);

  return criteria;
}

function notGradeable(
  assessmentId: string,
  answerId: string,
  reason: NotGradeableReason,
  questionId: string | null = null,
): GradingResult {
  return {
    id: randomUUID(),
    assessmentId,
    questionId,
    answerId,
    status: 'NOT_GRADEABLE',
    // No marks at all, rather than zero: an ungraded answer has not scored
    // nothing, it has not been scored.
    awardedMarks: null,
    maximumMarks: null,
    criteria: [],
    confidence: 0,
    confidenceFactors: null,
    feedback: '',
    notGradeableReason: reason,
    reviewReasons: [],
    metadata: null,
    isCurrent: true,
    supersededReason: null,
    createdAt: now(),
  };
}

/**
 * Retires the grades a new run replaces.
 *
 * Nothing is deleted. A grade made against a question a teacher later
 * overruled stays on the record marked superseded, so the history shows what
 * was marked, when, and against what.
 */
function supersede(
  previous: readonly GradingResult[],
  fresh: readonly GradingResult[],
): GradingResult[] {
  const freshIds = new Set(fresh.map((grade) => grade.id));
  const freshAnswerIds = new Set(fresh.map((grade) => grade.answerId));

  return previous
    .filter((grade) => !freshIds.has(grade.id))
    .map((grade) => {
      if (!grade.isCurrent || !freshAnswerIds.has(grade.answerId)) return grade;

      const replacement = fresh.find((entry) => entry.answerId === grade.answerId);

      return {
        ...grade,
        isCurrent: false,
        supersededReason:
          replacement && replacement.questionId !== grade.questionId
            ? 'The effective question mapping changed.'
            : 'Replaced by a later grading run.',
      };
    });
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

async function persist(
  assessmentId: string,
  grades: GradingResult[],
  markSchemes: MarkSchemeSet,
  metadata: GradingRunMetadata,
): Promise<void> {
  await getAssessmentStore().update(assessmentId, (current) => ({
    ...current,
    grades,
    markSchemes,
    grading: metadata,
    updatedAt: now(),
  }));
}
