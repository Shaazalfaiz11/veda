import { getEnv } from '@/lib/config';
import { clamp01, NEUTRAL_SIGNAL } from '@/lib/domain/mapping';

/**
 * Semantic similarity.
 *
 * Raw cosine cannot be used as a score. Everything on one exam paper shares
 * vocabulary, so two entirely unrelated exam texts still sit around 0.65-0.70
 * while a genuine match sits around 0.92 — a 0.69 that looks like "69%
 * confident" is really "no relationship at all".
 *
 * Two rescalings fix that, and both are needed:
 *
 *   absolute  maps [floor, 1] onto [0, 1], so a globally poor match cannot
 *             look good however weak its competition is.
 *
 *   relative  min-max across the candidate set for one answer, so the best
 *             available question stands out even on a paper where every
 *             cosine is high.
 *
 * Absolute alone would flatten a well-separated field; relative alone would
 * promote the least-bad option on a sheet that matches nothing. The mean of
 * the two keeps both failure modes in check.
 */
export function cosineSimilarity(a: readonly number[], b: readonly number[]): number {
  if (a.length !== b.length) {
    throw new Error(`Vector length mismatch: ${a.length} vs ${b.length}`);
  }

  let dot = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i += 1) {
    const x = a[i] ?? 0;
    const y = b[i] ?? 0;
    dot += x * y;
    normA += x * x;
    normB += y * y;
  }

  if (normA === 0 || normB === 0) return 0;
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}

/** Rescales one cosine against the floor below which texts are unrelated. */
export function absoluteSemanticScore(cosine: number): number {
  const floor = getEnv().MAPPING_SEMANTIC_FLOOR;
  if (floor >= 1) return clamp01(cosine);
  return clamp01((cosine - floor) / (1 - floor));
}

/**
 * Bounds for the relative component.
 *
 * Min-max over a small set is brutal: with two candidates one is always 0 and
 * the other always 1, however close their cosines actually are. Compressing
 * into this band keeps the ordering while stopping a two-horse race from
 * declaring the loser semantically unrelated.
 */
const RELATIVE_FLOOR = 0.2;
const RELATIVE_CEILING = 0.8;

/** How much of the signal the relative component may contribute. */
const RELATIVE_SHARE = 0.3;

/**
 * Rescales one cosine against the spread of the whole candidate set.
 * A set with no spread carries no information, so it returns neutral.
 */
export function relativeSemanticScore(cosine: number, allCosines: readonly number[]): number {
  if (allCosines.length === 0) return NEUTRAL_SIGNAL;

  const min = Math.min(...allCosines);
  const max = Math.max(...allCosines);
  const spread = max - min;

  if (spread < 1e-6) return NEUTRAL_SIGNAL;

  const position = clamp01((cosine - min) / spread);
  return RELATIVE_FLOOR + position * (RELATIVE_CEILING - RELATIVE_FLOOR);
}

/**
 * Absolute similarity leads; relative standing only adjusts it.
 *
 * The question "is this pair related at all?" is the one that matters, and
 * only the absolute score can answer it. Relative standing is a tiebreak
 * among candidates that are all plausible — given the lead role it would
 * promote the least-bad option on a sheet that matches nothing.
 */
export function semanticScore(cosine: number, allCosines: readonly number[]): number {
  return clamp01(
    (1 - RELATIVE_SHARE) * absoluteSemanticScore(cosine) +
      RELATIVE_SHARE * relativeSemanticScore(cosine, allCosines),
  );
}
