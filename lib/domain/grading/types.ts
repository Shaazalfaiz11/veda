import type { MarkSchemeSource } from './rubric';

/**
 * Grading domain.
 *
 * A grade answers "how many of these marks did this answer earn, and why".
 * It is attached to the *effective* mapping from Phase 6 — the question the
 * system currently believes the answer belongs to, whether the AI decided
 * that or a teacher did.
 *
 * Nothing here treats a model's number as the result. The model produces a
 * criterion-by-criterion recommendation; the application checks it against
 * the rubric, computes the total itself, and decides whether the outcome is
 * confident enough to stand without a human.
 */

export const GRADING_STATUSES = [
  /** No effective mapping, or nothing to grade against. */
  'NOT_GRADEABLE',
  'PENDING',
  'GRADING',
  'GRADED',
  /** Graded, but the evidence is too thin to apply the marks unattended. */
  'REVIEW_REQUIRED',
  'FAILED',
] as const;
export type GradingStatus = (typeof GRADING_STATUSES)[number];

/** Why an answer could not be graded. */
export const NOT_GRADEABLE_REASONS = [
  'NO_EFFECTIVE_QUESTION_MAPPING',
  'QUESTION_NOT_FOUND',
  'ANSWER_NOT_FOUND',
  'MARK_SCHEME_UNAVAILABLE',
] as const;
export type NotGradeableReason = (typeof NOT_GRADEABLE_REASONS)[number];

/** Why a graded answer still wants a human. */
export const REVIEW_REASONS = [
  'LOW_GRADING_CONFIDENCE',
  'UNCERTAIN_TRANSCRIPTION',
  'GENERATED_RUBRIC',
  'DIAGRAM_NOT_ASSESSABLE',
  'INSUFFICIENT_EVIDENCE',
] as const;
export type ReviewReason = (typeof REVIEW_REASONS)[number];

/** How fully a criterion was met. */
export const CRITERION_OUTCOMES = ['SATISFIED', 'PARTIAL', 'NOT_SATISFIED'] as const;
export type CriterionOutcome = (typeof CRITERION_OUTCOMES)[number];

export interface CriterionGrade {
  criterionId: string;
  description: string;
  awardedMarks: number;
  maximumMarks: number;
  outcome: CriterionOutcome;
  /** Why these marks, in terms of what the student actually wrote. */
  reason: string;
}

/**
 * The factors behind a grading confidence, kept individually so a low score
 * can be explained rather than merely reported.
 */
export interface GradingConfidenceFactors {
  /** How much the rubric itself is worth trusting. */
  rubricQuality: number;
  /** Whether the transcription was legible. */
  transcriptionClarity: number;
  /** The model's own stated confidence. One input, never the answer. */
  modelConfidence: number;
  /** Whether the criterion decisions were clear-cut rather than borderline. */
  criterionClarity: number;
}

export interface GradingMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  /** Content hash of the rubric this grade was made against. */
  markSchemeVersion: string;
  markSchemeSource: MarkSchemeSource;
  /** Bumped when the scoring or confidence logic changes. */
  algorithmVersion: string;
  gradedAt: string;
}

export interface GradingResult {
  id: string;
  assessmentId: string;

  /** The effective question at grading time. Null when not gradeable. */
  questionId: string | null;
  answerId: string;

  status: GradingStatus;

  /** Computed by the application from the criterion marks, never copied. */
  awardedMarks: number | null;
  maximumMarks: number | null;

  criteria: CriterionGrade[];

  /** Distinct from mapping confidence: how sure we are of the *marks*. */
  confidence: number;
  confidenceFactors: GradingConfidenceFactors | null;

  /** Written for the student, about their answer. */
  feedback: string;

  notGradeableReason: NotGradeableReason | null;
  reviewReasons: ReviewReason[];

  metadata: GradingMetadata | null;

  /**
   * True for the grade currently in force for this answer. Superseded grades
   * are kept with `false` — a teacher remapping an answer produces a new
   * grade without erasing the old one.
   */
  isCurrent: boolean;

  /** Why a previous grade was superseded, on the superseded record. */
  supersededReason: string | null;

  createdAt: string;
}

export interface GradingSummary {
  totalAnswers: number;
  graded: number;
  reviewRequired: number;
  notGradeable: number;
  failed: number;

  /** Totalled over current grades only. */
  awardedMarks: number;
  availableMarks: number;
  /** Marks for questions that were actually graded, as a percentage. */
  percentage: number | null;

  /** Marks on the paper that no graded answer accounted for. */
  ungradedMarks: number;
}

export interface GradingRunMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  algorithmVersion: string;
  gradedAt: string;
  answersConsidered: number;
  answersGraded: number;
  notGradeable: number;
  reviewRequired: number;
  gradingCalls: number;
  markSchemeSource: MarkSchemeSource;
}

export function isGradingStatus(value: unknown): value is GradingStatus {
  return typeof value === 'string' && (GRADING_STATUSES as readonly string[]).includes(value);
}

export function isCriterionOutcome(value: unknown): value is CriterionOutcome {
  return typeof value === 'string' && (CRITERION_OUTCOMES as readonly string[]).includes(value);
}
