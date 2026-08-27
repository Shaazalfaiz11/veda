/**
 * Embedding provider contract.
 *
 * The mapper depends on this, never on a vendor SDK, so the semantic signal
 * can be re-pointed at a different model — or a local one — without touching
 * any mapping logic.
 *
 * Batch-first by design: a paper with 20 questions and 15 answers is 35 texts,
 * which is one request here and 35 round trips if the interface were
 * single-text.
 */
export interface EmbeddingProvider {
  readonly name: string;
  readonly model: string;
  readonly dimensions: number;

  /**
   * Embeds a batch, returning one vector per input in the same order.
   * Vectors are L2-normalised, so cosine similarity is a plain dot product
   * and truncated dimensions stay comparable.
   */
  embed(texts: readonly string[]): Promise<number[][]>;
}

/** L2-normalises a vector. Zero vectors are returned unchanged. */
export function normalizeVector(vector: readonly number[]): number[] {
  let sum = 0;
  for (const value of vector) sum += value * value;

  const magnitude = Math.sqrt(sum);
  if (magnitude === 0) return [...vector];

  return vector.map((value) => value / magnitude);
}
