import { describe, expect, it } from 'vitest';

const { mergeChunkCandidates, isSameAnswer, intersectionOverUnion, textSimilarity } =
  await import('@/lib/services/answer/answer-merge');

import type { ExtractedAnswerCandidate } from '@/lib/providers/ai';
import type { PageChunk } from '@/lib/services/answer/answer-chunking';
import type { ChunkCandidate } from '@/lib/services/answer/answer-merge';

function region(
  pageNumber: number,
  y = 0.2,
  overrides: Partial<{ x: number; width: number; height: number }> = {},
) {
  return {
    pageNumber,
    x: overrides.x ?? 0.1,
    y,
    width: overrides.width ?? 0.7,
    height: overrides.height ?? 0.1,
    kind: 'text' as const,
  };
}

function candidate(
  overrides: Partial<ExtractedAnswerCandidate> = {},
): ExtractedAnswerCandidate {
  return {
    claimedLabelRaw: 'Q1',
    text: 'The chloroplast is the organelle responsible for photosynthesis.',
    regions: [region(1)],
    ...overrides,
  };
}

const chunk = (index: number, pageNumbers: number[]): PageChunk => ({ index, pageNumbers });

function entry(
  chunkIndex: number,
  pageNumbers: number[],
  overrides: Partial<ExtractedAnswerCandidate> = {},
): ChunkCandidate {
  return {
    chunkIndex,
    chunk: chunk(chunkIndex, pageNumbers),
    candidate: candidate(overrides),
  };
}

describe('geometry helpers', () => {
  it('scores identical rectangles as a full overlap', () => {
    expect(intersectionOverUnion(region(1), region(1))).toBeCloseTo(1);
  });

  it('scores disjoint rectangles as no overlap', () => {
    expect(intersectionOverUnion(region(1, 0.1), region(1, 0.9))).toBe(0);
  });

  it('scores a partial overlap between the two', () => {
    const iou = intersectionOverUnion(region(1, 0.2), region(1, 0.25));
    expect(iou).toBeGreaterThan(0);
    expect(iou).toBeLessThan(1);
  });
});

describe('text similarity', () => {
  it('ignores case and punctuation', () => {
    expect(textSimilarity('The cat sat.', 'the CAT sat')).toBeCloseTo(1);
  });

  it('separates unrelated sentences', () => {
    expect(textSimilarity('photosynthesis in chloroplasts', 'the heart pumps blood')).toBe(0);
  });
});

describe('recognising the same answer', () => {
  it('treats writing in the same place on the same page as one answer', () => {
    expect(isSameAnswer(candidate(), candidate({ text: 'The chloroplast is [unclear].' }))).toBe(
      true,
    );
  });

  /**
   * A student often writes near-identical working for two parts of a
   * question. Same words in a different place is not the same answer.
   */
  it('keeps identical text on different pages apart', () => {
    expect(isSameAnswer(candidate(), candidate({ regions: [region(2)] }))).toBe(false);
  });

  it('keeps identical text far apart on one page as separate answers', () => {
    expect(isSameAnswer(candidate(), candidate({ regions: [region(1, 0.85)] }))).toBe(false);
  });

  /**
   * Two chunks bounding the same paragraph differently — one took in a
   * trailing line the other cut. The overlap is too weak to decide on its
   * own, so the agreeing transcriptions carry it.
   */
  it('joins loosely-overlapping regions when the transcriptions agree', () => {
    const a = candidate({ regions: [region(1, 0.2, { height: 0.1 })] });
    const b = candidate({ regions: [region(1, 0.24, { height: 0.1 })] });

    expect(isSameAnswer(a, b)).toBe(true);
  });

  it('does not join loosely-overlapping regions when the text disagrees', () => {
    const a = candidate({ regions: [region(1, 0.2, { height: 0.1 })] });
    const b = candidate({
      regions: [region(1, 0.24, { height: 0.1 })],
      text: 'Osmosis moves water across a semi-permeable membrane.',
    });

    expect(isSameAnswer(a, b)).toBe(false);
  });
});

describe('merging across chunks', () => {
  it('leaves a single chunk untouched', () => {
    const outcome = mergeChunkCandidates([entry(0, [1, 2, 3, 4])]);

    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.duplicatesMerged).toBe(0);
  });

  it('folds a duplicate read by two overlapping chunks into one answer', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2, 3, 4], { regions: [region(4)] }),
      entry(1, [4, 5, 6, 7], { regions: [region(4)] }),
    ]);

    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.duplicatesMerged).toBe(1);
  });

  it('folds slightly different transcriptions of the same writing', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2, 3, 4], {
        regions: [region(4)],
        text: 'The human heart has four chambers. Blood enters the right atrium',
      }),
      entry(1, [4, 5, 6, 7], {
        regions: [region(4, 0.21)],
        text: 'The human heart has four chambers. Blood enters the right atrium and passes on.',
      }),
    ]);

    expect(outcome.candidates).toHaveLength(1);
  });

  /**
   * The point of the overlap. Chunk 0 sees only the part on page 4; chunk 1
   * holds pages 4 and 5 and reads the answer whole. The whole reading must
   * win, or the continuation is lost.
   */
  it('prefers the chunk that saw a spanning answer whole', () => {
    const truncated: ChunkCandidate = {
      chunkIndex: 0,
      chunk: chunk(0, [1, 2, 3, 4]),
      candidate: candidate({
        regions: [region(4)],
        text: 'Blood from the body enters the right atrium and then passes',
      }),
    };

    const whole: ChunkCandidate = {
      chunkIndex: 1,
      chunk: chunk(1, [4, 5, 6, 7]),
      candidate: candidate({
        regions: [region(4), region(5, 0.1)],
        text: 'Blood from the body enters the right atrium and then passes into the ventricle.',
      }),
    };

    const outcome = mergeChunkCandidates([truncated, whole]);

    expect(outcome.candidates).toHaveLength(1);
    expect(outcome.candidates[0]!.text).toContain('into the ventricle');
    expect(outcome.candidates[0]!.regions.map((r) => r.pageNumber)).toEqual([4, 5]);
  });

  it('is deterministic whichever order the chunks arrive in', () => {
    const a = entry(0, [1, 2, 3, 4], { regions: [region(4)], text: 'short' });
    const b = entry(1, [4, 5, 6, 7], { regions: [region(4)], text: 'a longer reading here' });

    const forward = mergeChunkCandidates([a, b]);
    const backward = mergeChunkCandidates([b, a]);

    expect(forward.candidates).toEqual(backward.candidates);
  });

  it('keeps genuinely different answers apart', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2, 3, 4], { regions: [region(1, 0.1)], text: 'Photosynthesis happens.' }),
      entry(0, [1, 2, 3, 4], { regions: [region(1, 0.6)], text: 'Osmosis is different.' }),
    ]);

    expect(outcome.candidates).toHaveLength(2);
    expect(outcome.duplicatesMerged).toBe(0);
  });

  it('carries a label through from whichever reading saw it', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2, 3, 4], { regions: [region(4)], claimedLabelRaw: null }),
      entry(1, [4, 5, 6, 7], { regions: [region(4)], claimedLabelRaw: 'Q5' }),
    ]);

    expect(outcome.candidates[0]!.claimedLabelRaw).toBe('Q5');
  });

  it('unions regions rather than keeping a duplicate rectangle', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2, 3, 4], { regions: [region(4)] }),
      entry(1, [4, 5, 6, 7], { regions: [region(4, 0.201)] }),
    ]);

    expect(outcome.candidates[0]!.regions).toHaveLength(1);
  });

  /**
   * Merging happens before validation. A candidate that could never be a real
   * answer must not be folded into a good one sharing its rectangle, or it
   * would vanish without ever being counted as rejected.
   */
  it('passes an empty transcription through instead of absorbing it', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2], { regions: [region(1)] }),
      entry(0, [1, 2], { regions: [region(1)], text: '' }),
    ]);

    expect(outcome.candidates).toHaveLength(2);
  });

  it('passes a wholly unreadable transcription through instead of absorbing it', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2], { regions: [region(1)] }),
      entry(0, [1, 2], { regions: [region(1)], text: '[unclear]' }),
    ]);

    expect(outcome.candidates).toHaveLength(2);
  });

  it('still merges a partly unreadable answer, which is a real answer', () => {
    const outcome = mergeChunkCandidates([
      entry(0, [1, 2, 3, 4], { regions: [region(4)], text: 'Force equals [unclear] times a.' }),
      entry(1, [4, 5, 6, 7], { regions: [region(4)], text: 'Force equals mass times a.' }),
    ]);

    expect(outcome.candidates).toHaveLength(1);
  });

  it('handles nothing at all', () => {
    expect(mergeChunkCandidates([])).toEqual({ candidates: [], duplicatesMerged: 0 });
  });
});
