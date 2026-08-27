import { ValidationError } from '@/lib/errors';

/**
 * Splitting an answer sheet into overlapping page chunks.
 *
 * Answer extraction cannot simply send a long sheet page by page: an answer
 * that runs from the bottom of one page to the top of the next is one answer,
 * and only a request that can see both pages can recognise it as such. Nor can
 * it send the whole sheet at once — past a dozen or so pages the reply grows
 * beyond what the model will return in one piece.
 *
 * Overlapping chunks are the compromise. Each chunk repeats the last `overlap`
 * pages of the one before it, so a boundary is never the only place an answer
 * is seen.
 *
 * The guarantee this buys is precise and worth stating, because it is not
 * "spanning answers always work". With chunk size `C` and overlap `V`, chunks
 * start every `S = C - V` pages. A run of `K` consecutive pages beginning at
 * page `p` sits inside the last chunk starting at or before `p` exactly when
 * `p - start <= C - K`, and `p - start` can be as large as `S - 1`. So every
 * run of `K` pages is guaranteed to fall wholly inside some chunk iff:
 *
 *     K <= V + 1
 *
 * At the default C=4, V=1 that covers every answer spanning two pages, which
 * is the case real sheets actually produce. An answer spanning three or more
 * pages may still straddle two boundaries; the merge step stitches those back
 * together where it can, but it is a recovery, not a guarantee.
 */

export interface PageChunk {
  /** 0-based position in the sequence, for logging and diagnostics. */
  index: number;
  /** Absolute page numbers, ascending. Never empty. */
  pageNumbers: number[];
}

export interface ChunkPlanOptions {
  chunkPages: number;
  overlap: number;
}

/** Longest answer span that is guaranteed to sit wholly inside one chunk. */
export function guaranteedSpan(overlap: number): number {
  return overlap + 1;
}

/**
 * Plans the chunks for a document.
 *
 * A sheet that already fits in one chunk produces exactly one chunk holding
 * every page — byte-for-byte the behaviour before chunking existed.
 */
export function planChunks(
  pageNumbers: readonly number[],
  options: ChunkPlanOptions,
): PageChunk[] {
  const { chunkPages, overlap } = options;

  if (!Number.isInteger(chunkPages) || chunkPages < 1) {
    throw new ValidationError('Chunk size must be a positive whole number of pages.', {
      chunkPages,
    });
  }

  if (!Number.isInteger(overlap) || overlap < 0) {
    throw new ValidationError('Chunk overlap must be zero or a positive whole number.', {
      overlap,
    });
  }

  // Stride would be zero or negative, so the walk below would never advance.
  if (overlap >= chunkPages) {
    throw new ValidationError('Chunk overlap must be smaller than the chunk size.', {
      chunkPages,
      overlap,
    });
  }

  const pages = [...pageNumbers].sort((a, b) => a - b);

  if (pages.length === 0) return [];
  if (pages.length <= chunkPages) return [{ index: 0, pageNumbers: pages }];

  const stride = chunkPages - overlap;
  const chunks: PageChunk[] = [];

  for (let start = 0; start < pages.length; start += stride) {
    const slice = pages.slice(start, start + chunkPages);
    chunks.push({ index: chunks.length, pageNumbers: slice });

    // The slice reached the end of the document, so any further chunk would
    // repeat pages already covered.
    if (start + chunkPages >= pages.length) break;
  }

  // The final stride can leave a short tail whose pages all appear in the
  // previous chunk. Sending it would spend a request on nothing new.
  const last = chunks[chunks.length - 1];
  const previous = chunks[chunks.length - 2];

  if (last && previous) {
    const covered = new Set(previous.pageNumbers);
    if (last.pageNumbers.every((page) => covered.has(page))) {
      chunks.pop();
    }
  }

  return chunks;
}

/**
 * Translates a chunk-local page number into an absolute one.
 *
 * The extraction prompt tells the model that the first image it was given is
 * page 1, so a chunk covering pages 7-10 reports its regions as pages 1-4.
 * Leaving that untranslated would put every answer after the first chunk on
 * the wrong page — and, downstream, draw its overlay across the wrong
 * handwriting.
 *
 * Returns null for an index the chunk does not have, so a model that invents
 * a page is rejected by validation rather than silently mapped onto a real
 * one.
 */
export function toAbsolutePageNumber(chunk: PageChunk, localPageNumber: number): number | null {
  if (!Number.isInteger(localPageNumber) || localPageNumber < 1) return null;
  return chunk.pageNumbers[localPageNumber - 1] ?? null;
}
