import type { AssessmentDocument } from '@/lib/domain/document';
import type { Question, QuestionExtractionMetadata } from '@/lib/domain/question';
import type { Answer, AnswerExtractionMetadata } from '@/lib/domain/answer';
import type { AnswerMapping, MappingMetadata } from '@/lib/domain/mapping';
import type { MappingReview, ReviewAuditEvent } from '@/lib/domain/review';
import type {
  GradingResult,
  GradingRunMetadata,
  MarkSchemeSet,
} from '@/lib/domain/grading';

/**
 * Lifecycle status of an assessment. Coarse-grained: what a caller needs to
 * decide whether to keep polling.
 */
export const ASSESSMENT_STATUSES = [
  'CREATED',
  'QUEUED',
  'PROCESSING',
  'COMPLETED',
  'FAILED',
] as const;

export type AssessmentStatus = (typeof ASSESSMENT_STATUSES)[number];

/**
 * Position within the processing pipeline. Only meaningful while the status
 * is PROCESSING; null before the worker picks the job up.
 */
export const PROCESSING_STAGES = [
  'PREPARING',
  'EXTRACTING_QUESTIONS',
  'EXTRACTING_ANSWERS',
  'MAPPING',
  'GRADING',
  'FINALIZING',
] as const;

export type ProcessingStage = (typeof PROCESSING_STAGES)[number];

export const TERMINAL_STATUSES: readonly AssessmentStatus[] = ['COMPLETED', 'FAILED'];

export function isAssessmentStatus(value: unknown): value is AssessmentStatus {
  return typeof value === 'string' && (ASSESSMENT_STATUSES as readonly string[]).includes(value);
}

export function isProcessingStage(value: unknown): value is ProcessingStage {
  return typeof value === 'string' && (PROCESSING_STAGES as readonly string[]).includes(value);
}

export function isTerminal(status: AssessmentStatus): boolean {
  return TERMINAL_STATUSES.includes(status);
}

/** A stage that has run to completion, recorded for idempotent retries. */
export interface CompletedStageRecord {
  stage: ProcessingStage;
  completedAt: string;
}

export interface AssessmentFailure {
  code: string;
  message: string;
  stage: ProcessingStage | null;
  failedAt: string;
}

export interface Assessment {
  id: string;
  status: AssessmentStatus;
  stage: ProcessingStage | null;

  /** BullMQ job id for the most recent processing run, if any. */
  jobId: string | null;

  /** Free-form label supplied at creation; useful for humans, never trusted. */
  title: string | null;

  /**
   * Documents uploaded against this assessment. Populated by the upload
   * endpoint and enriched with prepared pages by the PREPARING stage.
   */
  documents: AssessmentDocument[];

  /** Populated by the EXTRACTING_QUESTIONS stage. Ordered deterministically. */
  questions: Question[];

  /** Provenance for the extraction run that produced `questions`. */
  questionExtraction: QuestionExtractionMetadata | null;

  /**
   * Populated by the EXTRACTING_ANSWERS stage, in reading order. Answers
   * carry no question reference — mapping is a later, separate decision.
   */
  answers: Answer[];

  /** Provenance for the extraction run that produced `answers`. */
  answerExtraction: AnswerExtractionMetadata | null;

  /**
   * Populated by the MAPPING stage. A separate relationship — neither
   * questions nor answers are modified, so a mapping can be recomputed or
   * corrected without destroying extraction results.
   */
  mappings: AnswerMapping[];

  /** Provenance for the mapping run that produced `mappings`. */
  mapping: MappingMetadata | null;

  /**
   * Human review items. A decision layer over `mappings`, never a mutation of
   * it: the AI's conclusion stays exactly as it was recorded.
   */
  reviews: MappingReview[];

  /** Append-only record of every human action taken. */
  reviewAudit: ReviewAuditEvent[];

  /**
   * Rubrics resolved for this paper, and the ones that could not be tied to a
   * question. Kept on the record so a grade can always be traced back to the
   * mark scheme it was made against.
   */
  markSchemes: MarkSchemeSet | null;

  /**
   * Populated by the GRADING stage. Append-only: a grade superseded by a
   * remap stays here with `isCurrent: false` rather than being overwritten.
   */
  grades: GradingResult[];

  /** Provenance for the grading run that produced the current grades. */
  grading: GradingRunMetadata | null;

  completedStages: CompletedStageRecord[];
  failure: AssessmentFailure | null;

  createdAt: string;
  updatedAt: string;
}

/** Convenience lookups over an assessment's documents. */
export function findDocument(
  assessment: Assessment,
  documentId: string,
): AssessmentDocument | undefined {
  return assessment.documents.find((document) => document.id === documentId);
}

export function findDocumentByType(
  assessment: Assessment,
  type: AssessmentDocument['type'],
): AssessmentDocument | undefined {
  return assessment.documents.find((document) => document.type === type);
}
