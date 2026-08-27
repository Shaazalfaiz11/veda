/**
 * Global one-to-one assignment.
 *
 * Answers and questions form a weighted bipartite graph and we want the set
 * of pairings with the highest total score, subject to each side being used
 * at most once.
 *
 * Greedy — take the best remaining pair, repeat — is not good enough, and the
 * failure is not exotic. Given
 *
 *     Answer A:  Q1 = 0.92,  Q2 = 0.90
 *     Answer B:  Q1 = 0.91,  Q2 = 0.30
 *
 * greedy takes A→Q1 (0.92) and is then forced into B→Q2 (0.30), totalling
 * 1.22. The better solution is A→Q2 and B→Q1, totalling 1.81. Greedy cannot
 * find it because it never reconsiders a choice.
 *
 * So this is the Hungarian algorithm (Jonker-Volgenant shortest augmenting
 * path form, O(n³)), which finds the true optimum. At assessment scale — tens
 * of questions against tens of answers — that is microseconds, so there is no
 * reason to accept a worse answer for speed.
 *
 * Pairs scoring below the assignment floor are excluded before matching
 * rather than filtered afterwards: leaving them in would let the optimiser
 * "spend" an answer on a worthless pairing to free up a better one elsewhere.
 */

export interface AssignmentPair {
  rowIndex: number;
  columnIndex: number;
  score: number;
}

export interface AssignmentResult {
  pairs: AssignmentPair[];
  unassignedRows: number[];
  unassignedColumns: number[];
  totalScore: number;
}

export interface AssignmentOptions {
  /** Pairs scoring below this are never assigned. */
  minimumScore?: number;
}

const UNSET = -1;

/**
 * Maximises the total score over a rectangular matrix.
 *
 * `scores[row][column]` may be any finite number; use a score at or below
 * `minimumScore` to mark a pairing as not permitted.
 */
export function assignMaximumWeight(
  scores: readonly (readonly number[])[],
  options: AssignmentOptions = {},
): AssignmentResult {
  const minimumScore = options.minimumScore ?? Number.NEGATIVE_INFINITY;

  const rowCount = scores.length;
  const columnCount = rowCount === 0 ? 0 : (scores[0]?.length ?? 0);

  if (rowCount === 0 || columnCount === 0) {
    return {
      pairs: [],
      unassignedRows: Array.from({ length: rowCount }, (_, index) => index),
      unassignedColumns: Array.from({ length: columnCount }, (_, index) => index),
      totalScore: 0,
    };
  }

  // The algorithm below minimises, so costs are negated scores. Forbidden
  // pairs get a cost of 0 — equal to the padding — which makes leaving a row
  // unassigned exactly as attractive as taking a forbidden pair, and the
  // post-filter then drops it.
  const size = Math.max(rowCount, columnCount);
  const cost: number[][] = Array.from({ length: size }, () => new Array<number>(size).fill(0));

  for (let row = 0; row < rowCount; row += 1) {
    for (let column = 0; column < columnCount; column += 1) {
      const score = scores[row]?.[column] ?? Number.NEGATIVE_INFINITY;
      cost[row]![column] = Number.isFinite(score) && score >= minimumScore ? -score : 0;
    }
  }

  const columnAssignment = solveMinimumCost(cost, size);

  const pairs: AssignmentPair[] = [];
  const assignedRows = new Set<number>();
  const assignedColumns = new Set<number>();

  for (let column = 0; column < size; column += 1) {
    const row = columnAssignment[column]!;
    if (row === UNSET || row >= rowCount || column >= columnCount) continue;

    const score = scores[row]?.[column] ?? Number.NEGATIVE_INFINITY;
    // Padding and forbidden pairs both surface here as sub-threshold scores.
    if (!Number.isFinite(score) || score < minimumScore) continue;

    pairs.push({ rowIndex: row, columnIndex: column, score });
    assignedRows.add(row);
    assignedColumns.add(column);
  }

  pairs.sort((a, b) => a.rowIndex - b.rowIndex);

  return {
    pairs,
    unassignedRows: range(rowCount).filter((row) => !assignedRows.has(row)),
    unassignedColumns: range(columnCount).filter((column) => !assignedColumns.has(column)),
    totalScore: pairs.reduce((total, pair) => total + pair.score, 0),
  };
}

/**
 * Hungarian algorithm over a square cost matrix, returning for each column
 * the row assigned to it (or UNSET).
 *
 * Potentials `u` and `v` keep the reduced costs non-negative, and each
 * iteration grows an alternating tree along the cheapest reduced-cost edge
 * until it reaches a free column — the standard shortest-augmenting-path
 * construction.
 */
function solveMinimumCost(cost: readonly number[][], size: number): number[] {
  const u = new Array<number>(size + 1).fill(0);
  const v = new Array<number>(size + 1).fill(0);
  const columnToRow = new Array<number>(size + 1).fill(0);
  const way = new Array<number>(size + 1).fill(0);

  for (let row = 1; row <= size; row += 1) {
    columnToRow[0] = row;
    let column = 0;

    const minReduced = new Array<number>(size + 1).fill(Number.POSITIVE_INFINITY);
    const used = new Array<boolean>(size + 1).fill(false);

    do {
      used[column] = true;

      const currentRow = columnToRow[column]!;
      let delta = Number.POSITIVE_INFINITY;
      let nextColumn = 0;

      for (let candidate = 1; candidate <= size; candidate += 1) {
        if (used[candidate]) continue;

        const reduced = cost[currentRow - 1]![candidate - 1]! - u[currentRow]! - v[candidate]!;

        if (reduced < minReduced[candidate]!) {
          minReduced[candidate] = reduced;
          way[candidate] = column;
        }

        if (minReduced[candidate]! < delta) {
          delta = minReduced[candidate]!;
          nextColumn = candidate;
        }
      }

      // Shift the potentials so the chosen edge becomes tight.
      for (let candidate = 0; candidate <= size; candidate += 1) {
        if (used[candidate]) {
          u[columnToRow[candidate]!] = u[columnToRow[candidate]!]! + delta;
          v[candidate] = v[candidate]! - delta;
        } else {
          minReduced[candidate] = minReduced[candidate]! - delta;
        }
      }

      column = nextColumn;
    } while (columnToRow[column] !== 0);

    // Walk the alternating path back, flipping assignments as we go.
    do {
      const previous = way[column]!;
      columnToRow[column] = columnToRow[previous]!;
      column = previous;
    } while (column !== 0);
  }

  const result = new Array<number>(size).fill(UNSET);

  for (let column = 1; column <= size; column += 1) {
    const row = columnToRow[column]!;
    if (row > 0) result[column - 1] = row - 1;
  }

  return result;
}

function range(count: number): number[] {
  return Array.from({ length: count }, (_, index) => index);
}
