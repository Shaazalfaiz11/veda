import { describe, expect, it } from 'vitest';
import { assignMaximumWeight } from '@/lib/services/mapping/assignment';

function greedy(scores: number[][], minimumScore = Number.NEGATIVE_INFINITY) {
  const pairs: Array<{ rowIndex: number; columnIndex: number; score: number }> = [];
  const usedRows = new Set<number>();
  const usedColumns = new Set<number>();

  const all = scores.flatMap((row, rowIndex) =>
    row.map((score, columnIndex) => ({ rowIndex, columnIndex, score })),
  );
  all.sort((a, b) => b.score - a.score);

  for (const pair of all) {
    if (pair.score < minimumScore) continue;
    if (usedRows.has(pair.rowIndex) || usedColumns.has(pair.columnIndex)) continue;
    usedRows.add(pair.rowIndex);
    usedColumns.add(pair.columnIndex);
    pairs.push(pair);
  }

  return pairs.reduce((total, pair) => total + pair.score, 0);
}

describe('simple assignment', () => {
  it('pairs a one-to-one matrix optimally', () => {
    const result = assignMaximumWeight([
      [0.9, 0.1],
      [0.2, 0.8],
    ]);

    expect(result.pairs).toEqual([
      { rowIndex: 0, columnIndex: 0, score: 0.9 },
      { rowIndex: 1, columnIndex: 1, score: 0.8 },
    ]);
    expect(result.totalScore).toBeCloseTo(1.7, 6);
  });

  it('handles a single pair', () => {
    const result = assignMaximumWeight([[0.75]]);

    expect(result.pairs).toEqual([{ rowIndex: 0, columnIndex: 0, score: 0.75 }]);
    expect(result.unassignedRows).toEqual([]);
    expect(result.unassignedColumns).toEqual([]);
  });

  it('returns nothing for an empty matrix', () => {
    expect(assignMaximumWeight([]).pairs).toEqual([]);
    expect(assignMaximumWeight([[]]).pairs).toEqual([]);
  });
});

describe('global optimum over greedy', () => {
  it('solves the documented conflict case greedy gets wrong', () => {
    // Greedy takes A->Q1 (0.92) then is forced into B->Q2 (0.30) = 1.22.
    // The optimum is A->Q2 and B->Q1 = 1.81.
    const scores = [
      [0.92, 0.9],
      [0.91, 0.3],
    ];

    const result = assignMaximumWeight(scores);

    expect(result.totalScore).toBeCloseTo(1.81, 6);
    expect(result.totalScore).toBeGreaterThan(greedy(scores));

    expect(result.pairs).toEqual([
      { rowIndex: 0, columnIndex: 1, score: 0.9 },
      { rowIndex: 1, columnIndex: 0, score: 0.91 },
    ]);
  });

  it('beats greedy on a larger contested matrix', () => {
    const scores = [
      [0.95, 0.94, 0.2],
      [0.93, 0.1, 0.15],
      [0.9, 0.12, 0.11],
    ];

    const result = assignMaximumWeight(scores);
    expect(result.totalScore).toBeGreaterThanOrEqual(greedy(scores));
  });

  it('never assigns a row or a column twice', () => {
    const scores = [
      [0.9, 0.9, 0.9],
      [0.9, 0.9, 0.9],
      [0.9, 0.9, 0.9],
    ];

    const result = assignMaximumWeight(scores);

    expect(new Set(result.pairs.map((p) => p.rowIndex)).size).toBe(result.pairs.length);
    expect(new Set(result.pairs.map((p) => p.columnIndex)).size).toBe(result.pairs.length);
  });
});

describe('unequal sides', () => {
  it('leaves a question unmatched when there are fewer answers', () => {
    const result = assignMaximumWeight([[0.9, 0.4, 0.2]]);

    expect(result.pairs).toEqual([{ rowIndex: 0, columnIndex: 0, score: 0.9 }]);
    expect(result.unassignedRows).toEqual([]);
    expect(result.unassignedColumns).toEqual([1, 2]);
  });

  it('leaves an answer unmatched when there are fewer questions', () => {
    const result = assignMaximumWeight([[0.9], [0.4], [0.2]]);

    expect(result.pairs).toHaveLength(1);
    expect(result.pairs[0]).toEqual({ rowIndex: 0, columnIndex: 0, score: 0.9 });
    expect(result.unassignedRows).toEqual([1, 2]);
    expect(result.unassignedColumns).toEqual([]);
  });

  it('picks the best subset when answers outnumber questions', () => {
    const result = assignMaximumWeight([
      [0.3, 0.2],
      [0.95, 0.1],
      [0.1, 0.88],
    ]);

    expect(result.pairs).toEqual([
      { rowIndex: 1, columnIndex: 0, score: 0.95 },
      { rowIndex: 2, columnIndex: 1, score: 0.88 },
    ]);
    expect(result.unassignedRows).toEqual([0]);
  });
});

describe('assignment floor', () => {
  it('refuses pairs below the minimum score', () => {
    const result = assignMaximumWeight(
      [
        [0.9, 0.1],
        [0.2, 0.15],
      ],
      { minimumScore: 0.35 },
    );

    expect(result.pairs).toEqual([{ rowIndex: 0, columnIndex: 0, score: 0.9 }]);
    expect(result.unassignedRows).toEqual([1]);
    expect(result.unassignedColumns).toEqual([1]);
  });

  it('forces nothing when every pair is below the floor', () => {
    const result = assignMaximumWeight(
      [
        [0.1, 0.2],
        [0.15, 0.05],
      ],
      { minimumScore: 0.35 },
    );

    expect(result.pairs).toEqual([]);
    expect(result.unassignedRows).toEqual([0, 1]);
    expect(result.unassignedColumns).toEqual([0, 1]);
  });

  it('does not let a forbidden pair free up a better one elsewhere', () => {
    // Row 1 has nothing worth taking. It must stay unassigned rather than be
    // parked on a sub-threshold pair to release column 0.
    const result = assignMaximumWeight(
      [
        [0.95, 0.9],
        [0.05, 0.04],
      ],
      { minimumScore: 0.35 },
    );

    expect(result.pairs).toEqual([{ rowIndex: 0, columnIndex: 0, score: 0.95 }]);
    expect(result.unassignedRows).toEqual([1]);
  });
});

describe('determinism', () => {
  it('produces the same assignment across repeated runs', () => {
    const scores = [
      [0.81, 0.79, 0.4],
      [0.78, 0.82, 0.3],
      [0.2, 0.25, 0.77],
    ];

    const first = assignMaximumWeight(scores);
    for (let i = 0; i < 5; i += 1) {
      expect(assignMaximumWeight(scores).pairs).toEqual(first.pairs);
    }
  });

  it('reports a total equal to the sum of its pairs', () => {
    const result = assignMaximumWeight([
      [0.5, 0.6],
      [0.7, 0.4],
    ]);

    expect(result.totalScore).toBeCloseTo(
      result.pairs.reduce((total, pair) => total + pair.score, 0),
      9,
    );
  });
});
