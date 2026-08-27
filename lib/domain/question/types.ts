import type { PageRegion } from '@/lib/domain/document';
import type { QuestionSortKey } from './labels';

export type { QuestionSortKey };

/**
 * A question parsed from the printed paper.
 *
 * `labelRaw` is what the paper shows and what the UI renders.
 * `normalizedLabel` is the matching key the future mapper compares against.
 * `sortKey` exists only for ordering. Keeping the three separate means our
 * parse can be aggressive without ever changing what the teacher reads.
 *
 * `pageNumber` is 1-based, matching PreparedPage — the whole system uses one
 * page-numbering convention so a region can never land on the wrong page.
 */
export interface Question {
  /** Generated server-side. The model never supplies an identity. */
  id: string;

  labelRaw: string;
  normalizedLabel: string;
  sortKey: QuestionSortKey;

  /** Label of the owning major question, e.g. "4" for "4(a)". */
  parentLabel: string | null;
  isSubQuestion: boolean;

  text: string;

  /** Null when the paper does not print a mark allocation. Never inferred. */
  marks: number | null;

  pageNumber: number;

  /**
   * One or more regions, each carrying the page it lies on. Several when a
   * question's text is split across columns or continues onto the next page.
   */
  rects: PageRegion[];

  /** Pages this question's regions touch, ascending. */
  pageNumbers: number[];
}

/** Provenance for one extraction run. Enough to debug, nothing sensitive. */
export interface QuestionExtractionMetadata {
  provider: string;
  model: string;
  promptVersion: string;
  extractedAt: string;
  pagesProcessed: number;
  questionsExtracted: number;
  candidatesReceived: number;
  candidatesRejected: number;
  warnings: ExtractionWarning[];
  usage: ExtractionUsage | null;
}

/** Non-sensitive usage counters, when the provider reports them. */
export interface ExtractionUsage {
  promptTokens: number | null;
  responseTokens: number | null;
  totalTokens: number | null;
}

export type ExtractionWarningCode =
  | 'DUPLICATE_LABEL'
  | 'REJECTED_CANDIDATE'
  | 'MISSING_MARKS'
  | 'PAGE_OUT_OF_RANGE';

/**
 * A problem worth surfacing that did not invalidate the whole run. Duplicates
 * in particular are reported rather than silently resolved — inventing a
 * question number to hide the clash would be worse than naming it.
 */
export interface ExtractionWarning {
  code: ExtractionWarningCode;
  message: string;
  labelRaw: string | null;
}
