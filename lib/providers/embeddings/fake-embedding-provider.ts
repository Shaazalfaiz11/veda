import { createHash } from 'node:crypto';
import { normalizeVector, type EmbeddingProvider } from './types';

/**
 * Deterministic embedding provider for tests.
 *
 * Two modes. Scripted vectors let a test state exactly what similarity it
 * wants to exercise. Otherwise vectors are derived from a bag of words, so
 * texts sharing vocabulary genuinely come out closer together — which lets
 * candidate generation be tested end to end without a network call, and
 * without the vectors being meaningless noise.
 */
export interface FakeEmbeddingProviderOptions {
  /** Exact vectors keyed by input text. */
  vectors?: Record<string, number[]>;
  dimensions?: number;
  error?: Error;
  onEmbed?: (texts: readonly string[]) => void;
}

export class FakeEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'fake';
  readonly model = 'fake-embedding-v1';
  readonly dimensions: number;

  /** Batches requested — the probe for caching and batching assertions. */
  embedCalls = 0;
  /** Individual texts embedded across all calls. */
  embeddedTexts: string[] = [];

  constructor(private options: FakeEmbeddingProviderOptions = {}) {
    this.dimensions = options.dimensions ?? 64;
  }

  configure(options: FakeEmbeddingProviderOptions): void {
    this.options = { ...options, dimensions: this.dimensions };
  }

  reset(): void {
    this.embedCalls = 0;
    this.embeddedTexts = [];
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    this.embedCalls += 1;
    this.embeddedTexts.push(...texts);
    this.options.onEmbed?.(texts);

    if (this.options.error) throw this.options.error;

    return texts.map((text) => {
      const scripted = this.options.vectors?.[text];
      if (scripted) return normalizeVector(padTo(scripted, this.dimensions));
      return normalizeVector(bagOfWordsVector(text, this.dimensions));
    });
  }
}

/**
 * Hashes each word into a bucket, so shared vocabulary produces overlapping
 * buckets and therefore genuine similarity.
 *
 * A real embedding captures meaning — it knows "chloroplast" answers a
 * question about "photosynthesis" despite sharing no words. This cannot. A
 * test that depends on semantic discrimination should script its vectors
 * explicitly rather than rely on this, which is what the `vectors` option is
 * for; the derived form is only for tests where similarity is incidental.
 */
function bagOfWordsVector(text: string, dimensions: number): number[] {
  const vector = new Array<number>(dimensions).fill(0);

  const words = text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2);

  for (const word of words) {
    const digest = createHash('sha256').update(word).digest();
    const bucket = digest.readUInt32BE(0) % dimensions;
    vector[bucket] = (vector[bucket] ?? 0) + 1;
  }

  // A small floor keeps unrelated exam texts at a realistic non-zero cosine,
  // matching how real embeddings behave on one paper, without swamping the
  // word signal on short texts.
  return vector.map((value) => value + 0.05);
}

function padTo(vector: number[], dimensions: number): number[] {
  if (vector.length >= dimensions) return vector.slice(0, dimensions);
  return [...vector, ...new Array<number>(dimensions - vector.length).fill(0)];
}
