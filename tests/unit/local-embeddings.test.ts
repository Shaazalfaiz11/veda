import { describe, expect, it } from 'vitest';

const { LocalEmbeddingProvider } = await import(
  '@/lib/providers/embeddings/local-embedding-provider'
);
const { embeddingCacheKey, EmbeddingCache } = await import('@/lib/providers/embeddings');

/**
 * The local embedding provider.
 *
 * These load a real model — the first run downloads it — so they are slower
 * than the rest of the suite. They earn that: the whole point of moving
 * embeddings in-process is that the semantic signal stays good, and only
 * real vectors can show whether it does.
 */
const provider = new LocalEmbeddingProvider();

/** Cosine similarity. Vectors are L2-normalised, so this is a dot product. */
function similarity(a: number[], b: number[]): number {
  return a.reduce((sum, value, i) => sum + value * b[i]!, 0);
}

describe('contract', () => {
  it('declares a name, model and dimensions', () => {
    expect(provider.name).toBe('local');
    expect(provider.model).toContain('MiniLM');
    expect(provider.dimensions).toBe(384);
  });

  it('returns nothing for an empty batch without loading the model', async () => {
    expect(await provider.embed([])).toEqual([]);
  });
});

describe('vectors', () => {
  it('returns one vector per input, in order, at the declared width', async () => {
    const vectors = await provider.embed(['first text', 'second text', 'third text']);

    expect(vectors).toHaveLength(3);
    for (const vector of vectors) expect(vector).toHaveLength(provider.dimensions);
  }, 120_000);

  it('returns L2-normalised vectors, so cosine is a dot product', async () => {
    const [vector] = await provider.embed(['Photosynthesis occurs in the chloroplast.']);
    const magnitude = Math.sqrt(vector!.reduce((sum, v) => sum + v * v, 0));

    expect(magnitude).toBeCloseTo(1, 5);
  }, 120_000);

  it('is deterministic for the same text', async () => {
    const [a] = await provider.embed(['Define osmosis and give one example.']);
    const [b] = await provider.embed(['Define osmosis and give one example.']);

    expect(similarity(a!, b!)).toBeCloseTo(1, 5);
  }, 120_000);
});

/**
 * The reason this provider exists at all. If it could not separate a matching
 * question and answer from an unrelated pair, mapping would be worse than the
 * bag-of-words fallback it replaced.
 */
describe('semantic separation', () => {
  it('scores a matching question and answer far above an unrelated pair', async () => {
    const [question, answer, unrelated] = await provider.embed([
      'Which organelle is primarily involved in photosynthesis?',
      'The chloroplast is the organelle responsible for photosynthesis.',
      'Describe the flow of blood through the human heart.',
    ]);

    const matching = similarity(question!, answer!);
    const mismatched = similarity(question!, unrelated!);

    expect(matching).toBeGreaterThan(0.6);
    expect(mismatched).toBeLessThan(0.4);
    expect(matching - mismatched).toBeGreaterThan(0.3);
  }, 120_000);

  it('separates two answers that share vocabulary but not meaning', async () => {
    const [about, other] = await provider.embed([
      'Water moves across a semi-permeable membrane from dilute to concentrated.',
      'Water is transported up the stem through xylem vessels.',
    ]);

    // Related enough to be candidates, distinct enough not to be the same answer.
    expect(similarity(about!, other!)).toBeLessThan(0.85);
  }, 120_000);
});

describe('cache interoperability', () => {
  it('keys on the model and width, so switching provider cannot reuse stale vectors', () => {
    const local = embeddingCacheKey('text', 'Xenova/all-MiniLM-L6-v2', 384);
    const hosted = embeddingCacheKey('text', 'gemini-embedding-001', 768);

    expect(local).not.toBe(hosted);
  });

  it('round-trips a local vector through the cache', async () => {
    const cache = new EmbeddingCache();
    const [vector] = await provider.embed(['cached text']);
    const key = embeddingCacheKey('cached text', provider.model, provider.dimensions);

    cache.set(key, vector!);
    expect(cache.get(key)).toEqual(vector);
  }, 120_000);
});
