import { parseQuestionLabel } from '@/lib/domain/question';
import { textSimilarity } from '@/lib/services/answer/answer-merge';
import type { ExtractedQuestionCandidate } from '@/lib/providers/ai';
import type { PageChunk } from '@/lib/services/answer/answer-chunking';

/**
 * Reconciling questions seen by more than one chunk.
 *
 * Overlapping chunks read the boundary pages twice, so a question printed
 * there comes back twice — and, as with answers, rarely word for word,
 * because the two requests saw different amounts of surrounding context.
 *
 * Questions have something answers do not: a printed label. "Q7" is unique on
 * a paper, so where a label exists it settles identity outright and no
 * similarity heuristic is needed. Only unlabelled fragments fall back to
 * comparing text on a shared page.
 */

/** Token overlap above which two unlabelled fragments are the same question. */
const TEXT_SIMILARITY = 0.7;

export interface ChunkQuestion {
  chunkIndex: number;
  chunk: PageChunk;
  /** Page numbers already translated to absolute. */
  candidate: ExtractedQuestionCandidate;
}

export interface QuestionMergeOutcome {
  candidates: ExtractedQuestionCandidate[];
  duplicatesMerged: number;
}

export function mergeChunkQuestions(
  entries: readonly ChunkQuestion[],
): QuestionMergeOutcome {
  const groups: ChunkQuestion[][] = [];

  // Stable order, so the same input always produces the same output.
  const ordered = [...entries].sort(
    (a, b) => a.chunkIndex - b.chunkIndex || a.candidate.pageNumber - b.candidate.pageNumber,
  );

  for (const entry of ordered) {
    /*
     * Only readings from *different* chunks can be duplicates.
     *
     * Two candidates returned by one request are two things the model saw as
     * distinct while looking at both — which is exactly what a paper carrying
     * a genuinely repeated label looks like, and validation reports that as a
     * warning. Folding them here would erase the evidence before validation
     * ever saw it, and a single-chunk paper would be silently altered.
     */
    const group = groups.find((existing) =>
      existing.some(
        (member) =>
          member.chunkIndex !== entry.chunkIndex &&
          isSameQuestion(member.candidate, entry.candidate),
      ),
    );

    if (group) group.push(entry);
    else groups.push([entry]);
  }

  const merged = groups.map(mergeGroup);

  // Document order: the page a question starts on, then its position down it.
  merged.sort(
    (a, b) => a.pageNumber - b.pageNumber || topOf(a) - topOf(b) || leftOf(a) - leftOf(b),
  );

  return { candidates: merged, duplicatesMerged: ordered.length - groups.length };
}

/**
 * Whether two readings are the same printed question.
 *
 * A label is decisive both ways: two candidates carrying different labels are
 * different questions however similar their wording, which matters on a paper
 * where "(a)" and "(b)" of one question are near-identical in phrasing.
 */
export function isSameQuestion(
  a: ExtractedQuestionCandidate,
  b: ExtractedQuestionCandidate,
): boolean {
  const labelA = normalizedLabel(a.labelRaw);
  const labelB = normalizedLabel(b.labelRaw);

  if (labelA && labelB) return labelA === labelB;

  // At least one is unlabelled, so identity falls back to what was written —
  // but only for fragments found on the same page, since the same wording on
  // two pages is two questions.
  if (a.pageNumber !== b.pageNumber) return false;

  return textSimilarity(a.text, b.text) >= TEXT_SIMILARITY;
}

function normalizedLabel(labelRaw: string): string | null {
  const trimmed = labelRaw?.trim() ?? '';
  if (trimmed.length === 0) return null;

  const normalized = parseQuestionLabel(trimmed).normalizedLabel;
  return normalized.length > 0 ? normalized : null;
}

/**
 * Folds a group to one question.
 *
 * The fullest reading wins: a chunk that saw the question whole transcribed
 * more of it than one that caught its last two lines at a page break.
 */
function mergeGroup(group: ChunkQuestion[]): ExtractedQuestionCandidate {
  const winner = [...group].sort(byCompleteness)[0]!;

  const rects = dedupeRects(group.flatMap((entry) => entry.candidate.rects));

  return {
    labelRaw: winner.candidate.labelRaw || findFirstLabel(group),
    text: winner.candidate.text,
    // Marks are printed once; any reading that found them is better evidence
    // than a reading that missed them.
    marks: group.map((entry) => entry.candidate.marks).find((m) => m != null) ?? null,
    // The earliest page any reading placed it on: a question spotted at a
    // boundary belongs to the page it starts on.
    pageNumber: Math.min(...group.map((entry) => entry.candidate.pageNumber)),
    rects,
  };
}

function findFirstLabel(group: readonly ChunkQuestion[]): string {
  return group.map((entry) => entry.candidate.labelRaw).find((label) => label?.trim()) ?? '';
}

function byCompleteness(a: ChunkQuestion, b: ChunkQuestion): number {
  const lengthA = a.candidate.text.trim().length;
  const lengthB = b.candidate.text.trim().length;
  if (lengthA !== lengthB) return lengthB - lengthA;

  // Total order, so the result never depends on input order.
  return a.chunkIndex - b.chunkIndex;
}

interface Rect {
  pageNumber: number;
  x: number;
  y: number;
  width: number;
  height: number;
}

/** Drops rectangles that are the same rectangle read twice. */
function dedupeRects(rects: readonly Rect[]): Rect[] {
  const kept: Rect[] = [];

  for (const rect of rects) {
    const duplicate = kept.some(
      (existing) =>
        existing.pageNumber === rect.pageNumber &&
        Math.abs(existing.x - rect.x) < 0.02 &&
        Math.abs(existing.y - rect.y) < 0.02,
    );

    if (!duplicate) kept.push(rect);
  }

  return kept.sort((a, b) => a.pageNumber - b.pageNumber || a.y - b.y || a.x - b.x);
}

function topOf(candidate: ExtractedQuestionCandidate): number {
  const onPage = candidate.rects.filter((r) => r.pageNumber === candidate.pageNumber);
  const source = onPage.length > 0 ? onPage : candidate.rects;
  return source.length > 0 ? Math.min(...source.map((r) => r.y)) : 0;
}

function leftOf(candidate: ExtractedQuestionCandidate): number {
  const onPage = candidate.rects.filter((r) => r.pageNumber === candidate.pageNumber);
  const source = onPage.length > 0 ? onPage : candidate.rects;
  return source.length > 0 ? Math.min(...source.map((r) => r.x)) : 0;
}
