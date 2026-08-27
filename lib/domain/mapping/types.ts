/**
 * Mapping domain.
 *
 * A mapping is a *relationship* between an extracted Answer and an extracted
 * Question. It is stored separately and neither side is modified: extraction
 * results stay exactly as they were, so a mapping can be recomputed,
 * corrected by a teacher, or audited without destroying the evidence it was
 * derived from.
 *
 *     Question  ←──  AnswerMapping  ──→  Answer
 *
 * Nothing in this domain claims the model was right. Every mapping carries
 * the signals that produced it, the candidates that lost, and a confidence
 * the application calculated — so a wrong answer can be seen to be wrong
 * rather than merely asserted.
 */

/**
 * What the system decided to do with a mapping. Distinct from the
 * assessment's own processing status: an assessment can be COMPLETED while
 * several of its mappings sit in HUMAN_REVIEW.
 */
export const MAPPING_STATUSES = [
  'AUTO_MAPPED',
  'REVIEW_REQUIRED',
  'HUMAN_REVIEW',
  'UNMAPPED',
] as const;
export type MappingStatus = (typeof MAPPING_STATUSES)[number];

export const CONFIDENCE_BANDS = ['HIGH', 'MEDIUM', 'LOW'] as const;
export type ConfidenceBand = (typeof CONFIDENCE_BANDS)[number];

/**
 * Why a mapping came out the way it did.
 *
 * Stored because "confidence 0.93" on its own is not reviewable. A teacher
 * deciding whether to trust a mapping needs to know it rested on a written
 * label rather than on a vague semantic resemblance.
 */
export const MAPPING_REASON_CODES = [
  'DIRECT_LABEL_MATCH',
  'PARENT_SUBPART_MATCH',
  'SUBPART_ONLY_MATCH',
  'SEMANTIC_MATCH',
  'LABEL_AND_SEMANTIC_AGREE',
  'POSITIONAL_SUPPORT',
  'STRUCTURAL_SUPPORT',
  'LLM_VERIFIED',
  'LLM_SELECTED_ALTERNATIVE',
  'LLM_NO_MATCH',
  'LLM_UNAVAILABLE',
  'ADJUDICATION_UNNECESSARY',
  'CONFLICT_RESOLVED',
  'LABEL_CONFLICT',
  'LOW_CONFIDENCE',
  'NO_CANDIDATES',
  'NO_MATCH',
  'BELOW_ASSIGNMENT_THRESHOLD',
] as const;
export type MappingReasonCode = (typeof MAPPING_REASON_CODES)[number];

/** How a label comparison turned out. Each kind carries a fixed score. */
export const LABEL_MATCH_KINDS = [
  'EXACT_NORMALIZED_LABEL',
  'EXACT_PARENT_AND_SUBQUESTION',
  'PARENT_MATCH_SUBPART_MATCH',
  'PARENT_ONLY',
  'SUBPART_ONLY',
  'NO_LABEL',
  'CONFLICTING_LABEL',
] as const;
export type LabelMatchKind = (typeof LABEL_MATCH_KINDS)[number];

/**
 * The individual signals behind a candidate, each on a 0-1 scale where
 * 0.5 means "no information either way", not "half a match".
 */
export interface MappingSignals {
  label: number;
  labelKind: LabelMatchKind;
  semantic: number;
  /** Raw cosine, kept for debugging — never used as a score directly. */
  semanticCosine: number;
  position: number;
  structure: number;
}

/** One (answer, question) pair considered during candidate generation. */
export interface MappingCandidate {
  questionId: string;
  questionLabelRaw: string;
  signals: MappingSignals;
  /** Weighted combination of the signals. Not the final confidence. */
  candidateScore: number;
  /** Set once adjudication has run over this answer's candidates. */
  llmSelected: boolean;
  llmConfidence: number | null;
  /** Application-calculated confidence for this specific pair. */
  finalConfidence: number;
}

export type AdjudicationDecision = 'MATCH' | 'NO_MATCH';

/** What the adjudicator said, recorded verbatim and separately from our own score. */
export interface AdjudicationRecord {
  decision: AdjudicationDecision;
  questionId: string | null;
  reasonCode: string;
  /** The model's own confidence. A signal, never the final answer. */
  modelConfidence: number;
  provider: string;
  model: string;
  promptVersion: string;
}

export interface AnswerMapping {
  /**
   * Stable handle for this mapping decision. A review references it so a
   * human decision is anchored to the exact AI decision it responded to,
   * rather than to whatever the mapping happens to say later.
   */
  id: string;

  answerId: string;

  /** Null when the answer could not be mapped to any question. */
  questionId: string | null;

  status: MappingStatus;
  confidence: number;
  confidenceBand: ConfidenceBand;

  /** Signals for the assigned pair. Null when nothing was assigned. */
  signals: MappingSignals | null;

  reasonCodes: MappingReasonCode[];

  /**
   * Every candidate considered, best first — including the ones that lost.
   * This is what makes a mapping reviewable rather than merely stated.
   */
  candidates: MappingCandidate[];

  verification: AdjudicationRecord | null;

  createdAt: string;
}

export interface MappingResult {
  mappings: AnswerMapping[];
  /** Questions no answer was assigned to. */
  unmappedQuestionIds: string[];
  /** Answers that reached no question. */
  unmappedAnswerIds: string[];
}

export interface MappingMetadata {
  provider: string;
  model: string;
  embeddingModel: string;
  promptVersion: string;
  mappedAt: string;
  questionCount: number;
  answerCount: number;
  topK: number;

  autoMappedCount: number;
  reviewRequiredCount: number;
  humanReviewCount: number;
  unmappedCount: number;

  /** Adjudication calls actually made, after cache and skip decisions. */
  adjudicationCalls: number;
  /** Texts embedded, after cache hits. */
  embeddingCalls: number;

  weights: {
    label: number;
    semantic: number;
    position: number;
    structure: number;
    llm: number;
  };
  thresholds: { high: number; medium: number; minAssignment: number };
}

export function isMappingStatus(value: unknown): value is MappingStatus {
  return typeof value === 'string' && (MAPPING_STATUSES as readonly string[]).includes(value);
}
