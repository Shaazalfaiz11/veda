import { randomUUID } from 'node:crypto';
import { NormalizedRectSchema } from '@/lib/domain/document';
import type { PageRegion } from '@/lib/domain/document';
import {
  compareSortKeys,
  parseQuestionLabel,
  withParentMajor,
  type ExtractionWarning,
  type ParsedLabel,
  type Question,
} from '@/lib/domain/question';
import type { ExtractedQuestionCandidate } from '@/lib/providers/ai';

/**
 * Turning candidates into domain questions.
 *
 * This is the boundary where model output stops being a suggestion and
 * becomes application state, so nothing crosses it unexamined:
 *
 *  - geometry is validated, never clamped. A rect of x=1.4 means the model
 *    misunderstood the coordinate space, and quietly trimming it to 1.0 would
 *    bury that behind a plausible-looking highlight in the wrong place.
 *  - page numbers must exist in the prepared document.
 *  - ids are generated here. A model never names application state.
 *  - order comes from parsed labels, not from array position, so a model
 *    that returns questions slightly out of order still produces the same
 *    deterministic result.
 *  - duplicates are reported, never silently merged or renumbered.
 */

export interface ValidationInput {
  candidates: ExtractedQuestionCandidate[];
  /** Page numbers that actually exist on the prepared document. */
  availablePageNumbers: number[];
}

export interface ValidationOutcome {
  questions: Question[];
  warnings: ExtractionWarning[];
  rejectedCount: number;
}

interface RejectedCandidate {
  labelRaw: string;
  reason: string;
}

export function validateQuestionCandidates(input: ValidationInput): ValidationOutcome {
  const pages = new Set(input.availablePageNumbers);
  const warnings: ExtractionWarning[] = [];
  const rejected: RejectedCandidate[] = [];
  const accepted: AcceptedQuestion[] = [];

  for (const candidate of input.candidates) {
    const result = toQuestion(candidate, pages);

    if ('reason' in result) {
      rejected.push({ labelRaw: candidate.labelRaw, reason: result.reason });
      warnings.push({
        code: result.code,
        message: result.reason,
        labelRaw: candidate.labelRaw || null,
      });
      continue;
    }

    accepted.push(result);
  }

  // Deterministic: parsed order, with the original label as the final
  // tie-break so the result never depends on the order they arrived in.
  resolveLabelsFromReadingOrder(accepted);

  const questions = accepted.map((entry) => entry.question);
  questions.sort(compareSortKeys);

  warnings.push(...findDuplicates(questions));

  return { questions, warnings, rejectedCount: rejected.length };
}

interface AcceptedQuestion {
  question: Question;
  parsed: ParsedLabel;
}

type CandidateResult =
  | AcceptedQuestion
  | { reason: string; code: ExtractionWarning['code'] };

function toQuestion(
  candidate: ExtractedQuestionCandidate,
  pages: ReadonlySet<number>,
): CandidateResult {
  const labelRaw = candidate.labelRaw?.trim() ?? '';
  const text = candidate.text?.trim() ?? '';

  if (labelRaw.length === 0) {
    return { code: 'REJECTED_CANDIDATE', reason: 'Question has no label.' };
  }

  if (text.length === 0) {
    return {
      code: 'REJECTED_CANDIDATE',
      reason: `Question ${labelRaw} has no text.`,
    };
  }

  if (!Number.isInteger(candidate.pageNumber) || !pages.has(candidate.pageNumber)) {
    return {
      code: 'PAGE_OUT_OF_RANGE',
      reason: `Question ${labelRaw} names page ${candidate.pageNumber}, which the document does not have.`,
    };
  }

  if (candidate.marks !== null && candidate.marks !== undefined) {
    if (!Number.isFinite(candidate.marks) || candidate.marks < 0) {
      return {
        code: 'REJECTED_CANDIDATE',
        reason: `Question ${labelRaw} has a negative or non-numeric mark allocation.`,
      };
    }
  }

  if (!Array.isArray(candidate.rects) || candidate.rects.length === 0) {
    return {
      code: 'REJECTED_CANDIDATE',
      reason: `Question ${labelRaw} has no region.`,
    };
  }

  const rects: PageRegion[] = [];

  for (const rect of candidate.rects) {
    if (!Number.isInteger(rect.pageNumber) || !pages.has(rect.pageNumber)) {
      return {
        code: 'PAGE_OUT_OF_RANGE',
        reason: `Question ${labelRaw} has a region on page ${rect.pageNumber}, which the document does not have.`,
      };
    }

    const geometry = NormalizedRectSchema.safeParse({
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
    });

    if (!geometry.success) {
      return {
        code: 'REJECTED_CANDIDATE',
        reason: `Question ${labelRaw} has an invalid region: ${geometry.error.issues[0]?.message ?? 'unknown'}.`,
      };
    }

    // A zero-area region cannot be highlighted, so it is not a usable region.
    if (geometry.data.width === 0 || geometry.data.height === 0) {
      return {
        code: 'REJECTED_CANDIDATE',
        reason: `Question ${labelRaw} has a zero-area region.`,
      };
    }

    rects.push({ pageNumber: rect.pageNumber, ...geometry.data });
  }

  const parsed = parseQuestionLabel(labelRaw);
  const pageNumbers = [...new Set(rects.map((rect) => rect.pageNumber))].sort((a, b) => a - b);

  return {
    question: {
      id: randomUUID(),
      labelRaw,
      normalizedLabel: parsed.normalizedLabel,
      sortKey: parsed.sortKey,
      parentLabel: parsed.parentLabel,
      isSubQuestion: parsed.isSubQuestion,
      text,
      marks: candidate.marks ?? null,
      pageNumber: candidate.pageNumber,
      rects,
      pageNumbers,
    },
    parsed,
  };
}

/**
 * Attaches bare sub-parts to the question they sit under.
 *
 * Real papers print a numbered stem followed by "(a)", "(b)" — labels that
 * carry no owning number, so the hierarchy is only recoverable from position
 * on the page. The same is true of the bare "OR" that introduces an
 * alternative. Reading order is derived from page number and vertical offset
 * rather than from the model's array order, so the result does not depend on
 * the model having returned them in sequence.
 *
 * `labelRaw` is never touched: the paper printed "(a)" and that stays what the
 * teacher sees. Only the matching key and parent link are filled in.
 */
function resolveLabelsFromReadingOrder(entries: AcceptedQuestion[]): void {
  const inReadingOrder = [...entries].sort((a, b) => {
    if (a.question.pageNumber !== b.question.pageNumber) {
      return a.question.pageNumber - b.question.pageNumber;
    }
    return topOf(a.question) - topOf(b.question);
  });

  let lastMajor = 0;

  for (const entry of inReadingOrder) {
    if (!entry.parsed.isOrphanSubPart) {
      if (entry.question.sortKey.major > 0) {
        lastMajor = entry.question.sortKey.major;
      } else if (lastMajor > 0) {
        /*
         * An unnumbered label — the "OR" that introduces an alternative — has
         * no number to sort by, so its major stays 0 and it would otherwise
         * sort ahead of question 1 from wherever it appears in the paper. A
         * paper prints these directly beneath the question they belong to, so
         * that question's number is the honest anchor. Only the sort key
         * moves: labelRaw still reads "OR", and the matching key is left alone
         * so the mapper's view of it is unchanged.
         */
        entry.question.sortKey = { ...entry.question.sortKey, major: lastMajor };
      }
      continue;
    }

    if (lastMajor === 0) continue;

    const resolved = withParentMajor(entry.parsed, lastMajor);

    entry.question.sortKey = resolved.sortKey;
    entry.question.normalizedLabel = resolved.normalizedLabel;
    entry.question.parentLabel = resolved.parentLabel;
    entry.question.isSubQuestion = resolved.isSubQuestion;
  }
}

/** Topmost edge of a question's regions, for reading order. */
function topOf(question: Question): number {
  return Math.min(...question.rects.map((rect) => rect.y));
}

/**
 * Reports repeated identities.
 *
 * Both are kept. Discarding one would lose a real question, and renumbering
 * to break the tie would fabricate a label the paper never printed — the
 * clash is surfaced so a human can see it, and the mapper later treats a
 * duplicated label as low confidence rather than picking arbitrarily.
 */
function findDuplicates(questions: readonly Question[]): ExtractionWarning[] {
  const seen = new Map<string, Question[]>();

  for (const question of questions) {
    const group = seen.get(question.normalizedLabel);
    if (group) group.push(question);
    else seen.set(question.normalizedLabel, [question]);
  }

  const warnings: ExtractionWarning[] = [];

  for (const [normalizedLabel, group] of seen) {
    if (group.length < 2) continue;

    warnings.push({
      code: 'DUPLICATE_LABEL',
      message:
        `Label "${normalizedLabel}" appears ${group.length} times ` +
        `(as ${group.map((question) => `"${question.labelRaw}"`).join(', ')}). ` +
        'Both have been kept; neither was renumbered.',
      labelRaw: group[0]!.labelRaw,
    });
  }

  return warnings;
}
