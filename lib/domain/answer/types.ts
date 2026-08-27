import type { PageRegion } from '@/lib/domain/document';

/**
 * Answer domain.
 *
 * An Answer is one block of student work found on the answer sheet: what they
 * wrote, and exactly where they wrote it.
 *
 * It deliberately carries **no question reference**. Extraction answers "what
 * did the student write and where?"; deciding "which question is this?" is a
 * separate problem with separate evidence, and conflating them would let a
 * transcription artefact silently become a mapping decision. Even when the
 * student writes "Q4" beside their work, that is recorded as a *claim* —
 * `claimedLabelRaw` — not as a resolved identity.
 */

/**
 * What a region contains. Diagrams are located but not interpreted: the
 * prepared page stays the source of visual truth, and the region is what lets
 * the frontend point at it later.
 */
export const ANSWER_REGION_KINDS = ['text', 'diagram'] as const;
export type AnswerRegionKind = (typeof ANSWER_REGION_KINDS)[number];

export function isAnswerRegionKind(value: unknown): value is AnswerRegionKind {
  return typeof value === 'string' && (ANSWER_REGION_KINDS as readonly string[]).includes(value);
}

/**
 * One rectangle of student work, in the Phase 2 normalized coordinate system
 * and bound to the prepared page it was measured against.
 */
export interface AnswerRegion extends PageRegion {
  kind: AnswerRegionKind;
}

/**
 * Marker the transcription uses where handwriting is genuinely illegible.
 *
 * An explicit gap is worth more than a plausible guess: a wrong word read as
 * confident text corrupts everything downstream, whereas a marked gap tells
 * the teacher exactly where to look.
 */
export const UNCLEAR_MARKER = '[unclear]';

export interface Answer {
  /** Generated server-side. The model never supplies an identity. */
  id: string;

  /**
   * The question label the student wrote, exactly as it appears — "Q2",
   * "(a)", "4(b)". Null when they wrote none, which is a normal case and
   * never a reason to discard the answer.
   */
  claimedLabelRaw: string | null;

  /**
   * Canonical form of the claim, normalised the same way question labels are
   * so the two sides can be compared later. A bare "(a)" normalises to "a"
   * and stays there — resolving its parent question is not this phase's
   * decision to make.
   */
  claimedLabelNormalized: string | null;

  /** Faithful transcription. Illegible stretches carry UNCLEAR_MARKER. */
  text: string;

  /** One or more regions. Never forced into a single bounding box. */
  regions: AnswerRegion[];

  /** Pages this answer touches, ascending. */
  pageNumbers: number[];

  /** True when the answer continues onto another page. */
  spansPages: boolean;

  /** True when the transcription contains at least one illegible stretch. */
  hasUncertainSegments: boolean;

  /** True when at least one region is a diagram. */
  containsDiagram: boolean;

  /**
   * Zero-based reading-order position on the sheet.
   *
   * Extraction metadata only. It says where the answer sits, never which
   * question it belongs to — position is a weak signal that the mapping stage
   * may choose to weigh, not a decision this phase is entitled to make.
   */
  documentPosition: number;
}

/** Provenance for one extraction run. Enough to debug, nothing sensitive. */
export interface AnswerExtractionMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  extractedAt: string;
  pagesProcessed: number;
  answersExtracted: number;
  candidatesReceived: number;
  candidatesRejected: number;
  unlabelledCount: number;
  warnings: AnswerExtractionWarning[];
  usage: AnswerExtractionUsage | null;

  /** How many chunks the sheet was split into. 1 for a short sheet. */
  chunkCount: number;

  /**
   * Chunks that could not be read after their retries. Empty on a clean run.
   * Kept as page ranges and reasons so it is possible to say which part of the
   * sheet is missing, not merely that something is.
   */
  failedChunks: FailedChunk[];

  /**
   * True when at least one chunk was lost. The answers that were read are
   * still persisted — discarding fifteen good pages because the sixteenth
   * timed out helps nobody — but a partial transcript must never be mistaken
   * for a complete one, so it is stated here rather than inferred.
   */
  partial: boolean;

  /** Duplicate readings folded away by the overlap merge. */
  duplicatesMerged: number;
}

export interface FailedChunk {
  index: number;
  pageNumbers: number[];
  code: string;
  message: string;
}

export interface AnswerExtractionUsage {
  promptTokens: number | null;
  responseTokens: number | null;
  totalTokens: number | null;
}

export type AnswerExtractionWarningCode =
  | 'CHUNK_FAILED'
  | 'DUPLICATE_CLAIMED_LABEL'
  | 'REJECTED_CANDIDATE'
  | 'PAGE_OUT_OF_RANGE'
  | 'UNCERTAIN_TRANSCRIPTION'
  | 'NO_LABEL';

export interface AnswerExtractionWarning {
  code: AnswerExtractionWarningCode;
  message: string;
  claimedLabelRaw: string | null;
}

/** Whether a transcription admits to an illegible stretch. */
export function hasUncertainSegments(text: string): boolean {
  return text.includes(UNCLEAR_MARKER);
}
