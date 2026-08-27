import { getEnv } from '@/lib/config';
import { ValidationError } from '@/lib/errors';
import type { MarkScheme, RubricCriterion } from './rubric';
import { isValidMarkValue } from './rubric';
import type {
  CriterionGrade,
  CriterionOutcome,
  GradingConfidenceFactors,
  GradingStatus,
  ReviewReason,
} from './types';

/**
 * Scoring and confidence, in one place.
 *
 * Two rules run through all of it.
 *
 * The total is ours. A model that reports criteria of 2 + 1 + 0 and a total
 * of 4 has made an arithmetic error, and accepting either number would mean
 * accepting a mark the rubric does not support. The application adds the
 * criteria up itself and treats a mismatch as a malformed response.
 *
 * Confidence is ours too, and it is not the model's. A grader that is
 * confidently wrong would otherwise award itself a high score and skip the
 * review that would have caught it.
 */

/** Bumped when scoring or confidence logic changes, so grades stay traceable. */
export const GRADING_ALGORITHM_VERSION = 'grading/v1';

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/**
 * The total, computed from the criterion marks.
 *
 * Never reads a total the model supplied. `verifyCriterionTotal` is what
 * compares the two and rejects a disagreement.
 */
export function calculateAwardedMarks(criteria: readonly CriterionGrade[]): number {
  return criteria.reduce((total, criterion) => total + criterion.awardedMarks, 0);
}

/**
 * Rejects a model total that disagrees with its own criteria.
 *
 * Rejection rather than silent correction: the two numbers disagreeing means
 * the model was not reasoning consistently about this answer, and the marks
 * it assigned per criterion are no more trustworthy than the total it derived
 * from them. Better to fail and retry than to keep the half we happen to
 * prefer.
 */
export function verifyCriterionTotal(
  criteria: readonly CriterionGrade[],
  reportedTotal: number,
): void {
  const computed = calculateAwardedMarks(criteria);

  // Tolerance for float noise only, not for genuine disagreement.
  if (Math.abs(computed - reportedTotal) > 1e-6) {
    throw new ValidationError(
      `Grading is internally inconsistent: criteria sum to ${computed} but the total reported was ${reportedTotal}.`,
      { computed, reported: reportedTotal },
    );
  }
}

/** Checks one criterion's marks against the rubric that defines it. */
export function validateCriterionMarks(
  awarded: number,
  criterion: RubricCriterion,
  scheme: MarkScheme,
): void {
  if (!isValidMarkValue(awarded, scheme.granularity)) {
    throw new ValidationError(
      `Criterion ${criterion.id} was awarded ${awarded}, which is not a valid ${scheme.granularity.toLowerCase()} mark.`,
      { criterionId: criterion.id, awarded, granularity: scheme.granularity },
    );
  }

  if (awarded > criterion.maxMarks) {
    throw new ValidationError(
      `Criterion ${criterion.id} was awarded ${awarded} marks but is worth at most ${criterion.maxMarks}.`,
      { criterionId: criterion.id, awarded, maxMarks: criterion.maxMarks },
    );
  }

  if (!criterion.allowsPartialCredit && awarded !== 0 && awarded !== criterion.maxMarks) {
    throw new ValidationError(
      `Criterion ${criterion.id} is all-or-nothing but was awarded ${awarded} of ${criterion.maxMarks}.`,
      { criterionId: criterion.id, awarded, maxMarks: criterion.maxMarks },
    );
  }
}

/** Checks the whole grade against the question's mark ceiling. */
export function validateTotalMarks(awarded: number, scheme: MarkScheme): void {
  if (awarded > scheme.totalMarks) {
    throw new ValidationError(
      `The answer was awarded ${awarded} marks but the question is worth at most ${scheme.totalMarks}.`,
      { awarded, totalMarks: scheme.totalMarks },
    );
  }

  if (awarded < 0) {
    throw new ValidationError(`Awarded marks cannot be negative (got ${awarded}).`, { awarded });
  }
}

/** How fully a criterion was met, derived from the marks rather than claimed. */
export function outcomeForMarks(awarded: number, maxMarks: number): CriterionOutcome {
  if (maxMarks <= 0) return 'NOT_SATISFIED';
  if (awarded <= 0) return 'NOT_SATISFIED';
  if (awarded >= maxMarks) return 'SATISFIED';
  return 'PARTIAL';
}

export interface ConfidenceInput {
  scheme: MarkScheme;
  /** From Phase 4: the transcription admitted an illegible stretch. */
  answerHasUncertainSegments: boolean;
  /** From Phase 4: the answer includes a drawing the grader cannot see. */
  answerContainsDiagram: boolean;
  /** Whether the question asked for a diagram. */
  questionExpectsDiagram: boolean;
  modelConfidence: number;
  criteria: readonly CriterionGrade[];
}

/**
 * Grading confidence.
 *
 * A separate number from mapping confidence and deliberately so: being sure
 * an answer belongs to Q4 says nothing about being sure it earned three
 * marks. Reusing one for the other would let a crisp label match vouch for a
 * guess about the marking.
 *
 * The four factors are averaged with fixed weights. This is an engineering
 * signal for deciding what a human should look at — it is not a calibrated
 * probability, and nothing here pretends otherwise.
 */
export function calculateGradingConfidence(
  input: ConfidenceInput,
): { confidence: number; factors: GradingConfidenceFactors } {
  const env = getEnv();

  // A rubric the examiner wrote is worth far more than one we inferred from
  // the question's printed marks.
  const rubricQuality = input.scheme.source === 'PROVIDED' ? 1 : 0.55;

  // An illegible stretch does not make the answer wrong, but it does mean we
  // may be marking words the student did not write.
  const transcriptionClarity = input.answerHasUncertainSegments ? 0.4 : 1;

  // A diagram the question asked for cannot be assessed from a transcript.
  const diagramPenalty =
    input.questionExpectsDiagram && input.answerContainsDiagram ? 0.6 : 1;

  // Clear-cut criterion decisions are more trustworthy than a row of
  // borderline partials.
  const criterionClarity = input.criteria.length === 0
    ? 0.5
    : clamp01(
        input.criteria.filter((c) => c.outcome !== 'PARTIAL').length / input.criteria.length,
      ) *
        0.4 +
      0.6;

  const factors: GradingConfidenceFactors = {
    rubricQuality: clamp01(rubricQuality * diagramPenalty),
    transcriptionClarity: clamp01(transcriptionClarity),
    modelConfidence: clamp01(input.modelConfidence),
    criterionClarity: clamp01(criterionClarity),
  };

  const confidence = clamp01(
    env.GRADING_WEIGHT_RUBRIC * factors.rubricQuality +
      env.GRADING_WEIGHT_TRANSCRIPTION * factors.transcriptionClarity +
      env.GRADING_WEIGHT_MODEL * factors.modelConfidence +
      env.GRADING_WEIGHT_CRITERION * factors.criterionClarity,
  );

  return { confidence, factors };
}

/**
 * Whether a grade can stand unattended.
 *
 * Marks are never withheld — the grade is computed and stored either way.
 * What changes is whether a human is asked to look before it counts.
 */
export function resolveGradingStatus(input: {
  confidence: number;
  scheme: MarkScheme;
  answerHasUncertainSegments: boolean;
  answerContainsDiagram: boolean;
  questionExpectsDiagram: boolean;
}): { status: GradingStatus; reviewReasons: ReviewReason[] } {
  const env = getEnv();
  const reviewReasons: ReviewReason[] = [];

  if (input.confidence < env.GRADING_CONFIDENCE_THRESHOLD) {
    reviewReasons.push('LOW_GRADING_CONFIDENCE');
  }

  if (input.answerHasUncertainSegments) reviewReasons.push('UNCERTAIN_TRANSCRIPTION');
  if (input.scheme.source === 'GENERATED') reviewReasons.push('GENERATED_RUBRIC');

  if (input.questionExpectsDiagram && input.answerContainsDiagram) {
    reviewReasons.push('DIAGRAM_NOT_ASSESSABLE');
  }

  return {
    status: reviewReasons.length > 0 ? 'REVIEW_REQUIRED' : 'GRADED',
    reviewReasons,
  };
}
