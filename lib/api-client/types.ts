/**
 * Response shapes the browser sees.
 *
 * These are deliberately *not* imported from `lib/domain` — those modules
 * reach into the config, the logger and Redis, and pulling them into a client
 * bundle would drag server-only code with them. What is described here is the
 * JSON the routes actually return, which is a narrower thing than the domain
 * model and is allowed to differ from it.
 */

export type AssessmentStatus = 'CREATED' | 'QUEUED' | 'PROCESSING' | 'COMPLETED' | 'FAILED';

export type ProcessingStage =
  | 'PREPARING'
  | 'EXTRACTING_QUESTIONS'
  | 'EXTRACTING_ANSWERS'
  | 'MAPPING'
  | 'GRADING'
  | 'FINALIZING';

export type DocumentType = 'QUESTION_PAPER' | 'ANSWER_SHEET';

export type DocumentStatus = 'UPLOADED' | 'PREPARING' | 'READY' | 'FAILED';

export interface CreatedAssessment {
  assessmentId: string;
  status: AssessmentStatus;
  title: string | null;
  createdAt: string;
}

export interface DocumentMetadata {
  id: string;
  assessmentId: string;
  type: DocumentType;
  status: DocumentStatus;
  originalFilename: string | null;
  format: string;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  failure: { code: string; message: string } | null;
  uploadedAt: string;
  preparedAt: string | null;
}

export interface PreparedPageMetadata {
  pageNumber: number;
  width: number;
  height: number;
  aspectRatio: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  rotation: number;
  mimeType: string;
  sizeBytes: number;
}

export interface DocumentWithPages extends DocumentMetadata {
  pages: PreparedPageMetadata[];
}

export interface ProcessingTicket {
  assessmentId: string;
  jobId: string;
  status: 'QUEUED';
}

export interface AssessmentStatusView {
  assessmentId: string;
  status: AssessmentStatus;
  stage: ProcessingStage | null;
  progress: number;
  jobId: string | null;
  documents: Array<{
    id: string;
    type: DocumentType;
    status: DocumentStatus;
    pageCount: number | null;
  }>;
  failure: { code: string; message: string; stage: ProcessingStage | null } | null;
  updatedAt: string;
}

/**
 * A rectangle in normalized page space: origin top-left, both axes in [0,1].
 *
 * These never become pixels in stored state. The viewer multiplies them by
 * whatever size the page image is currently rendered at, which is what makes
 * an overlay survive zooming and resizing.
 */
export interface NormalizedRect {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

export interface AnswerRegion extends NormalizedRect {
  kind: 'text' | 'diagram';
}

export interface Question {
  id: string;
  labelRaw: string;
  normalizedLabel: string;
  parentLabel: string | null;
  isSubQuestion: boolean;
  text: string;
  marks: number | null;
  pageNumber: number;
  rects: NormalizedRect[];
  pageNumbers: number[];
}

export interface Answer {
  id: string;
  claimedLabelRaw: string | null;
  claimedLabelNormalized: string | null;
  text: string;
  regions: AnswerRegion[];
  pageNumbers: number[];
  spansPages: boolean;
  hasUncertainSegments: boolean;
  containsDiagram: boolean;
  documentPosition: number;
}

export type ConfidenceBand = 'HIGH' | 'MEDIUM' | 'LOW';

export interface MappingEntry {
  answerId: string;
  aiMapping: {
    mappingId: string;
    questionId: string | null;
    status: string;
    confidence: number;
    confidenceBand: ConfidenceBand;
    reasonCodes: string[];
  };
  humanReview: {
    reviewId: string;
    status: string;
    action: string | null;
    questionId: string | null;
    reason: string | null;
    reviewerId: string | null;
    decidedAt: string | null;
  } | null;
  effectiveMapping: {
    questionId: string | null;
    source: 'AI' | 'HUMAN';
    confidence: number | null;
    confidenceBand: ConfidenceBand | null;
  };
}

export type GradingStatus =
  | 'NOT_GRADEABLE'
  | 'PENDING'
  | 'GRADING'
  | 'GRADED'
  | 'REVIEW_REQUIRED'
  | 'FAILED';

export interface CriterionGrade {
  criterionId: string;
  description: string;
  awardedMarks: number;
  maximumMarks: number;
  outcome: 'SATISFIED' | 'PARTIAL' | 'NOT_SATISFIED';
  reason: string;
}

export interface GradeItem {
  gradeId: string;
  answerId: string;
  questionId: string | null;
  status: GradingStatus;
  awardedMarks: number | null;
  maximumMarks: number | null;
  criteria: CriterionGrade[];
  confidence: number;
  feedback: string;
  notGradeableReason: string | null;
  reviewReasons: string[];
  markScheme: { source: string; version: string; totalMarks: number } | null;
  question: { id: string; labelRaw: string; text: string; marks: number | null } | null;
  answer: {
    id: string;
    claimedLabelRaw: string | null;
    text: string;
    hasUncertainSegments: boolean;
    containsDiagram: boolean;
    pageNumbers: number[];
  } | null;
  mappingSource: 'AI' | 'HUMAN' | null;
  gradedAt: string;
}

export interface GradingSummary {
  totalAnswers: number;
  graded: number;
  reviewRequired: number;
  notGradeable: number;
  failed: number;
  awardedMarks: number;
  availableMarks: number;
  percentage: number | null;
  ungradedMarks: number;
}

export interface ReviewItem {
  reviewId: string;
  answerId: string;
  status: 'PENDING' | 'IN_REVIEW' | 'RESOLVED' | 'SKIPPED';
  trigger: string;
  aiMapping: {
    questionId: string | null;
    confidence: number;
    confidenceBand: ConfidenceBand;
    reasonCodes: string[];
  };
  humanReview: {
    action: string | null;
    questionId: string | null;
    reason: string | null;
    reviewerId: string | null;
    decidedAt: string | null;
  };
  effectiveMapping: { questionId: string | null; source: 'AI' | 'HUMAN' };
  answer: { id: string; claimedLabelRaw: string | null; text: string } | null;
  candidates: Array<{
    questionId: string;
    questionLabelRaw: string;
    questionText: string | null;
    finalConfidence: number;
  }>;
}

/** The envelope every failing route returns. */
export interface ApiErrorBody {
  error: { code: string; message: string; details?: unknown };
}
