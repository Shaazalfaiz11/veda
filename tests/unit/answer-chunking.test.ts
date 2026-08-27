import { describe, expect, it } from 'vitest';

const { planChunks, toAbsolutePageNumber, guaranteedSpan } = await import(
  '@/lib/services/answer/answer-chunking'
);
const { ValidationError } = await import('@/lib/errors');

const pagesUpTo = (n: number) => Array.from({ length: n }, (_, i) => i + 1);
const ranges = (chunks: { pageNumbers: number[] }[]) => chunks.map((c) => c.pageNumbers);

describe('planning chunks', () => {
  it('reads a short sheet in a single chunk, as before chunking existed', () => {
    expect(ranges(planChunks(pagesUpTo(2), { chunkPages: 4, overlap: 1 }))).toEqual([[1, 2]]);
  });

  it('reads an exactly-chunk-sized sheet in one chunk', () => {
    expect(ranges(planChunks(pagesUpTo(4), { chunkPages: 4, overlap: 1 }))).toEqual([
      [1, 2, 3, 4],
    ]);
  });

  it('splits a long sheet into overlapping chunks', () => {
    expect(ranges(planChunks(pagesUpTo(10), { chunkPages: 4, overlap: 1 }))).toEqual([
      [1, 2, 3, 4],
      [4, 5, 6, 7],
      [7, 8, 9, 10],
    ]);
  });

  it('covers every page of an 18-page sheet', () => {
    const chunks = planChunks(pagesUpTo(18), { chunkPages: 4, overlap: 1 });
    const covered = new Set(chunks.flatMap((chunk) => chunk.pageNumbers));

    expect([...covered].sort((a, b) => a - b)).toEqual(pagesUpTo(18));
  });

  it('numbers chunks in order', () => {
    const chunks = planChunks(pagesUpTo(10), { chunkPages: 4, overlap: 1 });
    expect(chunks.map((chunk) => chunk.index)).toEqual([0, 1, 2]);
  });

  it('emits no chunk whose pages the previous chunk already covered', () => {
    // 7 pages, stride 3: 1-4, 4-7, then a tail of [7] that adds nothing.
    const chunks = planChunks(pagesUpTo(7), { chunkPages: 4, overlap: 1 });

    expect(ranges(chunks)).toEqual([
      [1, 2, 3, 4],
      [4, 5, 6, 7],
    ]);
  });

  it('supports zero overlap', () => {
    expect(ranges(planChunks(pagesUpTo(8), { chunkPages: 4, overlap: 0 }))).toEqual([
      [1, 2, 3, 4],
      [5, 6, 7, 8],
    ]);
  });

  it('returns nothing for a sheet with no pages', () => {
    expect(planChunks([], { chunkPages: 4, overlap: 1 })).toEqual([]);
  });

  it('sorts pages that arrive out of order', () => {
    expect(ranges(planChunks([3, 1, 2], { chunkPages: 4, overlap: 1 }))).toEqual([[1, 2, 3]]);
  });

  it('refuses an overlap that would stop the walk advancing', () => {
    expect(() => planChunks(pagesUpTo(10), { chunkPages: 4, overlap: 4 })).toThrow(
      ValidationError,
    );
  });

  it('refuses a non-positive chunk size', () => {
    expect(() => planChunks(pagesUpTo(10), { chunkPages: 0, overlap: 0 })).toThrow(
      ValidationError,
    );
  });
});

/**
 * The reason overlap exists. Any answer spanning at most `overlap + 1` pages
 * must sit wholly inside one chunk, or the split would break it in two.
 */
describe('the spanning guarantee', () => {
  it('states the span it guarantees', () => {
    expect(guaranteedSpan(1)).toBe(2);
    expect(guaranteedSpan(2)).toBe(3);
  });

  it.each([
    { chunkPages: 4, overlap: 1 },
    { chunkPages: 5, overlap: 2 },
    { chunkPages: 3, overlap: 1 },
    { chunkPages: 6, overlap: 3 },
  ])('holds for chunkPages=$chunkPages overlap=$overlap', ({ chunkPages, overlap }) => {
    const chunks = planChunks(pagesUpTo(40), { chunkPages, overlap });
    const span = guaranteedSpan(overlap);

    // Every window of `span` consecutive pages fits inside at least one chunk.
    for (let start = 1; start + span - 1 <= 40; start += 1) {
      const window = Array.from({ length: span }, (_, i) => start + i);

      const contained = chunks.some((chunk) => {
        const pages = new Set(chunk.pageNumbers);
        return window.every((page) => pages.has(page));
      });

      expect(contained, `pages ${window.join(',')} split across chunks`).toBe(true);
    }
  });
});

describe('translating chunk-local page numbers', () => {
  const chunk = { index: 2, pageNumbers: [7, 8, 9, 10] };

  it('maps the first image of a chunk onto the chunk’s first page', () => {
    expect(toAbsolutePageNumber(chunk, 1)).toBe(7);
  });

  it('maps the last image onto the last page', () => {
    expect(toAbsolutePageNumber(chunk, 4)).toBe(10);
  });

  /**
   * A model that cites a page its chunk never held must not have that turned
   * into a real page number — the region would end up drawn over unrelated
   * handwriting.
   */
  it('refuses an index beyond the chunk', () => {
    expect(toAbsolutePageNumber(chunk, 5)).toBeNull();
  });

  it('refuses a zero or negative index', () => {
    expect(toAbsolutePageNumber(chunk, 0)).toBeNull();
    expect(toAbsolutePageNumber(chunk, -1)).toBeNull();
  });

  it('refuses a fractional index', () => {
    expect(toAbsolutePageNumber(chunk, 1.5)).toBeNull();
  });
});
