import { createHash } from 'node:crypto';

/**
 * Embedding cache.
 *
 * Question text does not change between answers, so embedding it once per
 * assessment instead of once per comparison removes almost all the calls a
 * naive mapper would make.
 *
 * Deliberately an in-process Map. A vector database — or Redis vector search —
 * would be real infrastructure to run and reason about, and an assessment is
 * a few dozen short texts held for the length of one job. The cost of getting
 * that wrong is far higher than the cost of re-embedding on a cold worker.
 */
export function embeddingCacheKey(text: string, model: string, dimensions: number): string {
  // Whitespace-normalised so trivial formatting differences do not miss.
  const normalized = text.replace(/\s+/g, ' ').trim().toLowerCase();

  return createHash('sha256')
    .update(`${model}:${dimensions}:${normalized}`)
    .digest('hex');
}

export class EmbeddingCache {
  private readonly entries = new Map<string, number[]>();

  hits = 0;
  misses = 0;

  get(key: string): number[] | undefined {
    const found = this.entries.get(key);
    if (found) this.hits += 1;
    else this.misses += 1;
    return found;
  }

  set(key: string, vector: number[]): void {
    this.entries.set(key, vector);
  }

  get size(): number {
    return this.entries.size;
  }

  clear(): void {
    this.entries.clear();
    this.hits = 0;
    this.misses = 0;
  }
}
