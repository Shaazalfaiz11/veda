import { UNCLEAR_MARKER } from '@/lib/domain/answer';
import type { ExtractedAnswerCandidate } from '@/lib/providers/ai';
import type { PageChunk } from './answer-chunking';

/**
 * Reconciling candidates seen by more than one chunk.
 *
 * Overlapping chunks mean the pages at a boundary are read twice, so the same
 * block of writing comes back twice — and rarely word-for-word identical, because
 * the two requests saw different amounts of context around it. Deduplicating on
 * exact text would therefore keep both copies, and the student would appear to
 * have answered twice.
 *
 * What is stable between the two readings is *where the writing is*. The same
 * handwriting occupies the same rectangle on the same page whichever chunk was
 * looking at it, so geometry is the primary signal here and text is corroboration.
 *
 * Which copy survives matters as much as spotting the duplicate. At a boundary
 * one chunk sees an answer whole and the other sees it cut off, and the truncated
 * reading is a worse transcription of the same work. The winner is therefore the
 * copy whose own chunk contained the most of its pages — the reading that had the
 * least amputated.
 */

/** Region overlap above which two candidates are the same writing. */
const STRONG_IOU = 0.5;

/** Weaker overlap, accepted only when the transcriptions also agree. */
const WEAK_IOU = 0.15;

/** Token overlap above which two transcriptions are the same answer. */
const TEXT_SIMILARITY = 0.6;

export interface ChunkCandidate {
  chunkIndex: number;
  /** The chunk this was read from, for judging how much of the answer it saw. */
  chunk: PageChunk;
  /** Page numbers already translated to absolute. */
  candidate: ExtractedAnswerCandidate;
}

export interface MergeOutcome {
  candidates: ExtractedAnswerCandidate[];
  /** How many duplicate readings were folded away. */
  duplicatesMerged: number;
}

export function mergeChunkCandidates(entries: readonly ChunkCandidate[]): MergeOutcome {
  const groups: ChunkCandidate[][] = [];

  // Greedy grouping over a stable order, so the same input always produces the
  // same output regardless of which chunk happened to finish first.
  const ordered = [...entries].sort((a, b) => a.chunkIndex - b.chunkIndex);

  /*
   * A candidate that cannot be a real answer cannot be a duplicate of one.
   *
   * Merging runs before validation, so without this an empty or wholly
   * unreadable candidate sharing a rectangle with a good one would be folded
   * into it and quietly disappear — never reaching validation, never counted
   * as rejected, and leaving the run looking cleaner than it was. These pass
   * straight through so validation still sees and rejects them.
   *
   * This is not a second copy of the validation rules: it asks only whether a
   * candidate is substantive enough to be worth deduplicating. Validation
   * remains the sole authority on what is accepted.
   */
  const mergeable: ChunkCandidate[] = [];
  const passthrough: ChunkCandidate[] = [];

  for (const entry of ordered) {
    if (isSubstantive(entry.candidate)) mergeable.push(entry);
    else passthrough.push(entry);
  }

  for (const entry of mergeable) {
    /*
     * Only readings from *different* chunks can be duplicates. Two candidates
     * returned by one request are two blocks the model distinguished while
     * looking at both, and overriding that judgement here would merge work a
     * student genuinely wrote twice.
     */
    const group = groups.find((existing) =>
      existing.some(
        (member) =>
          member.chunkIndex !== entry.chunkIndex &&
          isSameAnswer(member.candidate, entry.candidate),
      ),
    );

    if (group) group.push(entry);
    else groups.push([entry]);
  }

  const duplicatesMerged = mergeable.length - groups.length;

  return {
    candidates: [
      ...groups.map(mergeGroup),
      ...passthrough.map((entry) => entry.candidate),
    ],
    duplicatesMerged,
  };
}

/** Has text that survives stripping the unclear markers, and at least one region. */
function isSubstantive(candidate: ExtractedAnswerCandidate): boolean {
  if (!Array.isArray(candidate.regions) || candidate.regions.length === 0) return false;

  const text = candidate.text?.trim() ?? '';
  if (text.length === 0) return false;

  return text.split(UNCLEAR_MARKER).join('').trim().length > 0;
}

/**
 * Whether two readings are the same block of writing.
 *
 * They must share a page — two candidates on different pages are different
 * answers however similar their wording, which matters when a student writes
 * near-identical working for two parts of a question.
 */
export function isSameAnswer(
  a: ExtractedAnswerCandidate,
  b: ExtractedAnswerCandidate,
): boolean {
  const shared = sharedPages(a, b);
  if (shared.length === 0) return false;

  const overlap = bestRegionOverlap(a, b, shared);

  if (overlap >= STRONG_IOU) return true;

  // Geometry disagrees more than usual — the two chunks bounded the writing
  // differently — but the words are the same, so it is the same answer.
  if (overlap >= WEAK_IOU && textSimilarity(a.text, b.text) >= TEXT_SIMILARITY) {
    return true;
  }

  return false;
}

/**
 * Folds one group down to a single candidate.
 *
 * The winning transcription is kept whole rather than spliced: stitching two
 * partial readings together would invent text that neither request actually
 * returned. Regions are unioned, because a truncated reading can still
 * contribute a rectangle the winner missed.
 */
function mergeGroup(group: ChunkCandidate[]): ExtractedAnswerCandidate {
  const winner = [...group].sort(byCompleteness)[0]!;

  const regions = dedupeRegions(group.flatMap((entry) => entry.candidate.regions));

  return {
    // A label seen by any reading is better evidence than none, but the
    // winner's own label takes precedence when it has one.
    claimedLabelRaw:
      winner.candidate.claimedLabelRaw ??
      group.map((entry) => entry.candidate.claimedLabelRaw).find((label) => label != null) ??
      null,
    text: winner.candidate.text,
    regions,
  };
}

/**
 * Ranks readings of the same answer, best first.
 *
 * "Best" is the one whose chunk held the most of the answer's pages: a chunk
 * that saw both halves of a spanning answer read it whole, while the chunk
 * that only had the first page necessarily cut it off.
 */
function byCompleteness(a: ChunkCandidate, b: ChunkCandidate): number {
  const seenA = pagesSeenWithinChunk(a);
  const seenB = pagesSeenWithinChunk(b);
  if (seenA !== seenB) return seenB - seenA;

  const pagesA = pagesOf(a.candidate).length;
  const pagesB = pagesOf(b.candidate).length;
  if (pagesA !== pagesB) return pagesB - pagesA;

  // A longer transcription of the same writing is the less truncated one.
  const lengthA = a.candidate.text.trim().length;
  const lengthB = b.candidate.text.trim().length;
  if (lengthA !== lengthB) return lengthB - lengthA;

  // Total order, so the result never depends on input order.
  return a.chunkIndex - b.chunkIndex;
}

/** How many of this answer's pages its own chunk actually contained. */
function pagesSeenWithinChunk(entry: ChunkCandidate): number {
  const inChunk = new Set(entry.chunk.pageNumbers);
  return pagesOf(entry.candidate).filter((page) => inChunk.has(page)).length;
}

function pagesOf(candidate: ExtractedAnswerCandidate): number[] {
  return [...new Set(candidate.regions.map((region) => region.pageNumber))].sort(
    (a, b) => a - b,
  );
}

function sharedPages(a: ExtractedAnswerCandidate, b: ExtractedAnswerCandidate): number[] {
  const pagesB = new Set(pagesOf(b));
  return pagesOf(a).filter((page) => pagesB.has(page));
}

/** The strongest region agreement between two candidates on any shared page. */
function bestRegionOverlap(
  a: ExtractedAnswerCandidate,
  b: ExtractedAnswerCandidate,
  shared: readonly number[],
): number {
  let best = 0;

  for (const page of shared) {
    for (const regionA of a.regions.filter((region) => region.pageNumber === page)) {
      for (const regionB of b.regions.filter((region) => region.pageNumber === page)) {
        best = Math.max(best, intersectionOverUnion(regionA, regionB));
      }
    }
  }

  return best;
}

interface Rect {
  x: number;
  y: number;
  width: number;
  height: number;
}

export function intersectionOverUnion(a: Rect, b: Rect): number {
  const left = Math.max(a.x, b.x);
  const top = Math.max(a.y, b.y);
  const right = Math.min(a.x + a.width, b.x + b.width);
  const bottom = Math.min(a.y + a.height, b.y + b.height);

  if (right <= left || bottom <= top) return 0;

  const intersection = (right - left) * (bottom - top);
  const union = a.width * a.height + b.width * b.height - intersection;

  return union <= 0 ? 0 : intersection / union;
}

/**
 * Token overlap between two transcriptions, 0 to 1.
 *
 * Deliberately crude — punctuation and case are dropped and word order is
 * ignored. Two readings of the same handwriting differ in exactly those ways,
 * while two genuinely different answers differ in their vocabulary, which is
 * what this measures.
 */
export function textSimilarity(a: string, b: string): number {
  const tokensA = tokenize(a);
  const tokensB = tokenize(b);

  if (tokensA.size === 0 && tokensB.size === 0) return 1;
  if (tokensA.size === 0 || tokensB.size === 0) return 0;

  let shared = 0;
  for (const token of tokensA) {
    if (tokensB.has(token)) shared += 1;
  }

  return shared / (tokensA.size + tokensB.size - shared);
}

function tokenize(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .replace(/[^\p{L}\p{N}\s]/gu, ' ')
      .split(/\s+/)
      .filter((token) => token.length > 0),
  );
}

/**
 * Drops rectangles that are really the same rectangle read twice, keeping the
 * first — which, given the group is ordered by completeness, is the winner's.
 */
function dedupeRegions(
  regions: readonly ExtractedAnswerCandidate['regions'][number][],
): ExtractedAnswerCandidate['regions'] {
  const kept: ExtractedAnswerCandidate['regions'] = [];

  for (const region of regions) {
    const duplicate = kept.some(
      (existing) =>
        existing.pageNumber === region.pageNumber &&
        intersectionOverUnion(existing, region) >= STRONG_IOU,
    );

    if (!duplicate) kept.push(region);
  }

  return kept.sort((a, b) => a.pageNumber - b.pageNumber || a.y - b.y || a.x - b.x);
}
