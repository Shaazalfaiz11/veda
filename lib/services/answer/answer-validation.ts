import { randomUUID } from 'node:crypto';
import { NormalizedRectSchema } from '@/lib/domain/document';
import {
  UNCLEAR_MARKER,
  hasUncertainSegments,
  isAnswerRegionKind,
  type Answer,
  type AnswerExtractionWarning,
  type AnswerRegion,
} from '@/lib/domain/answer';
import { parseQuestionLabel } from '@/lib/domain/question';
import type { ExtractedAnswerCandidate } from '@/lib/providers/ai';

/**
 * Turning answer candidates into domain answers.
 *
 * The same boundary rules as question extraction apply — geometry validated
 * and never clamped, page numbers checked against the prepared document, ids
 * generated here, ordering derived rather than trusted.
 *
 * One rule is specific to this phase and matters more than the rest: nothing
 * in here resolves a question. A student's "Q4" becomes `claimedLabelRaw`,
 * and a bare "(a)" normalises to "a" and stops there. Working out which
 * question owns an answer needs evidence this stage does not have, and an
 * answer that arrives at the mapper already carrying a guessed identity is
 * worse than one that arrives honestly unlabelled.
 */

export interface AnswerValidationInput {
  candidates: ExtractedAnswerCandidate[];
  /** Page numbers that actually exist on the prepared answer sheet. */
  availablePageNumbers: number[];
}

export interface AnswerValidationOutcome {
  answers: Answer[];
  warnings: AnswerExtractionWarning[];
  rejectedCount: number;
}

export function validateAnswerCandidates(
  input: AnswerValidationInput,
): AnswerValidationOutcome {
  const pages = new Set(input.availablePageNumbers);
  const warnings: AnswerExtractionWarning[] = [];
  const accepted: Answer[] = [];
  let rejectedCount = 0;

  for (const candidate of input.candidates) {
    const result = toAnswer(candidate, pages);

    if ('reason' in result) {
      rejectedCount += 1;
      warnings.push({
        code: result.code,
        message: result.reason,
        claimedLabelRaw: candidate.claimedLabelRaw ?? null,
      });
      continue;
    }

    accepted.push(result.answer);
  }

  // Reading order, derived from where the writing sits rather than from the
  // order the model happened to emit.
  accepted.sort(compareByDocumentPosition);
  accepted.forEach((answer, index) => {
    answer.documentPosition = index;
  });

  warnings.push(...findDuplicateClaims(accepted));
  warnings.push(...reportUncertainty(accepted));
  warnings.push(...reportUnlabelled(accepted));

  return { answers: accepted, warnings, rejectedCount };
}

type CandidateResult =
  | { answer: Answer }
  | { reason: string; code: AnswerExtractionWarning['code'] };

function toAnswer(
  candidate: ExtractedAnswerCandidate,
  pages: ReadonlySet<number>,
): CandidateResult {
  const text = candidate.text?.trim() ?? '';

  // A label is optional; a transcription is not. An answer with no text is a
  // region with nothing in it, which the mapper could never use.
  if (text.length === 0) {
    return { code: 'REJECTED_CANDIDATE', reason: 'Answer has no transcribed text.' };
  }

  // Nor can it use one that is nothing *but* unclear markers. A partly
  // illegible answer is worth keeping — that is what the marker is for — but
  // when stripping the markers leaves nothing behind, the model has reported
  // that it could not read the region at all. Letting that through would put
  // an empty answer in front of the mapper and, eventually, mark a student
  // against a transcription that says nothing.
  if (text.split(UNCLEAR_MARKER).join('').trim().length === 0) {
    return {
      code: 'REJECTED_CANDIDATE',
      reason: 'Answer transcribed as unreadable in its entirety.',
    };
  }

  if (!Array.isArray(candidate.regions) || candidate.regions.length === 0) {
    return { code: 'REJECTED_CANDIDATE', reason: 'Answer has no region.' };
  }

  const regions: AnswerRegion[] = [];

  for (const region of candidate.regions) {
    if (!Number.isInteger(region.pageNumber) || !pages.has(region.pageNumber)) {
      return {
        code: 'PAGE_OUT_OF_RANGE',
        reason: `Answer has a region on page ${region.pageNumber}, which the answer sheet does not have.`,
      };
    }

    const geometry = NormalizedRectSchema.safeParse({
      x: region.x,
      y: region.y,
      width: region.width,
      height: region.height,
    });

    if (!geometry.success) {
      return {
        code: 'REJECTED_CANDIDATE',
        reason: `Answer has an invalid region: ${geometry.error.issues[0]?.message ?? 'unknown'}.`,
      };
    }

    if (geometry.data.width === 0 || geometry.data.height === 0) {
      return { code: 'REJECTED_CANDIDATE', reason: 'Answer has a zero-area region.' };
    }

    regions.push({
      pageNumber: region.pageNumber,
      ...geometry.data,
      kind: isAnswerRegionKind(region.kind) ? region.kind : 'text',
    });
  }

  const claimedLabelRaw = candidate.claimedLabelRaw?.trim() || null;
  const pageNumbers = [...new Set(regions.map((region) => region.pageNumber))].sort(
    (a, b) => a - b,
  );

  return {
    answer: {
      id: randomUUID(),
      claimedLabelRaw,
      // Normalised for comparison later, but deliberately left unresolved: a
      // bare "(a)" stays "a" rather than being attached to a parent question.
      claimedLabelNormalized: claimedLabelRaw
        ? parseQuestionLabel(claimedLabelRaw).normalizedLabel
        : null,
      text,
      regions,
      pageNumbers,
      spansPages: pageNumbers.length > 1,
      hasUncertainSegments: hasUncertainSegments(text),
      containsDiagram: regions.some((region) => region.kind === 'diagram'),
      // Filled in once the whole set is ordered.
      documentPosition: 0,
    },
  };
}

/**
 * Reading order: earliest page first, then highest on that page.
 *
 * This is extraction metadata, not a mapping signal. It exists so the same
 * input always produces the same output, and so a later stage has a stable
 * notion of "the answer above this one" if it chooses to use it.
 */
function compareByDocumentPosition(a: Answer, b: Answer): number {
  const pageA = a.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER;
  const pageB = b.pageNumbers[0] ?? Number.MAX_SAFE_INTEGER;
  if (pageA !== pageB) return pageA - pageB;

  const topA = topOf(a);
  const topB = topOf(b);
  if (topA !== topB) return topA - topB;

  const leftA = leftOf(a);
  const leftB = leftOf(b);
  if (leftA !== leftB) return leftA - leftB;

  // Final fallback so the ordering is total and never input-dependent.
  return a.text.localeCompare(b.text);
}

/**
 * Position is measured only on the page the answer *starts* on.
 *
 * A spanning answer continues near the top of the following page, so taking
 * the minimum across every region would let that continuation drag the answer
 * to the top of its first page and reorder the sheet. Reading order is where
 * the writing begins, not the highest point it ever reaches.
 */
function startRegions(answer: Answer): readonly AnswerRegion[] {
  const firstPage = answer.pageNumbers[0];
  const onFirstPage = answer.regions.filter((region) => region.pageNumber === firstPage);
  return onFirstPage.length > 0 ? onFirstPage : answer.regions;
}

function topOf(answer: Answer): number {
  return Math.min(...startRegions(answer).map((region) => region.y));
}

function leftOf(answer: Answer): number {
  return Math.min(...startRegions(answer).map((region) => region.x));
}

/**
 * Reports repeated claims without acting on them.
 *
 * Two blocks both labelled "Q2" may be one answer split by a diagram, two
 * attempts at the same question, or a mislabelling. Merging them would
 * destroy evidence and discarding one would lose real work — so both are
 * kept and the clash is named for the stage that has the evidence to settle
 * it.
 */
function findDuplicateClaims(answers: readonly Answer[]): AnswerExtractionWarning[] {
  const groups = new Map<string, Answer[]>();

  for (const answer of answers) {
    if (!answer.claimedLabelNormalized) continue;

    const group = groups.get(answer.claimedLabelNormalized);
    if (group) group.push(answer);
    else groups.set(answer.claimedLabelNormalized, [answer]);
  }

  const warnings: AnswerExtractionWarning[] = [];

  for (const [normalized, group] of groups) {
    if (group.length < 2) continue;

    warnings.push({
      code: 'DUPLICATE_CLAIMED_LABEL',
      message:
        `${group.length} answers claim label "${normalized}" ` +
        `(written as ${group.map((answer) => `"${answer.claimedLabelRaw}"`).join(', ')}). ` +
        'All were kept; none were merged.',
      claimedLabelRaw: group[0]!.claimedLabelRaw,
    });
  }

  return warnings;
}

function reportUncertainty(answers: readonly Answer[]): AnswerExtractionWarning[] {
  const uncertain = answers.filter((answer) => answer.hasUncertainSegments);
  if (uncertain.length === 0) return [];

  return [
    {
      code: 'UNCERTAIN_TRANSCRIPTION',
      message:
        `${uncertain.length} answer${uncertain.length === 1 ? '' : 's'} contain ` +
        'handwriting that could not be read and was marked rather than guessed.',
      claimedLabelRaw: uncertain[0]!.claimedLabelRaw,
    },
  ];
}

/**
 * Notes how many answers carry no written label. Informational only —
 * an unlabelled answer is a normal, expected case, never a defect.
 */
function reportUnlabelled(answers: readonly Answer[]): AnswerExtractionWarning[] {
  const unlabelled = answers.filter((answer) => answer.claimedLabelRaw === null);
  if (unlabelled.length === 0) return [];

  return [
    {
      code: 'NO_LABEL',
      message:
        `${unlabelled.length} answer${unlabelled.length === 1 ? '' : 's'} carry no written ` +
        'question label. They have been kept for the mapping stage to resolve.',
      claimedLabelRaw: null,
    },
  ];
}
