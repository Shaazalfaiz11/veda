import { logger } from '@/lib/logger';
import { DependencyUnavailableError } from '@/lib/errors';
import { normalizeVector, type EmbeddingProvider } from './types';

/**
 * Embeddings computed in this process, with no API behind them.
 *
 * Mapping needs a semantic signal for every question and every answer, which
 * is dozens of vectors per assessment. Buying those from a hosted model puts
 * the most quota-hungry part of the pipeline on the same budget as the parts
 * that genuinely need a large model to reason — and it is the part that needs
 * it least. A sentence-transformer small enough to run locally produces
 * comparable similarity for this task at no request cost at all.
 *
 * `all-MiniLM-L6-v2` is the choice: 384 dimensions, ~90MB, and trained
 * specifically for sentence similarity rather than adapted from a generative
 * model. The weights are fetched once on first use and cached on disk
 * thereafter, so only the first run pays for them.
 *
 * The model is loaded lazily and shared process-wide. Loading it costs a few
 * seconds and a few hundred megabytes of memory; doing that per call, or at
 * import time in a process that never maps anything, would be waste.
 */

const MODEL_ID = 'Xenova/all-MiniLM-L6-v2';
const DIMENSIONS = 384;

/**
 * The pipeline, once. `transformers` is imported dynamically so that merely
 * importing this module — which the provider registry does eagerly — does not
 * drag the ONNX runtime into a process that will never embed anything.
 */
type FeatureExtractor = (
  texts: string[],
  options: { pooling: 'mean'; normalize: boolean },
) => Promise<{ tolist(): number[][] }>;

let extractorPromise: Promise<FeatureExtractor> | null = null;

async function loadExtractor(): Promise<FeatureExtractor> {
  extractorPromise ??= (async () => {
    try {
      // TEMPORARY DIAGNOSTIC — stall investigation.
      const startedAt = Date.now();
      logger.info({ model: MODEL_ID }, 'diag.model_load.start');

      const { pipeline } = await import('@huggingface/transformers');
      const extractor = await pipeline('feature-extraction', MODEL_ID);

      logger.info(
        { model: MODEL_ID, durationMs: Date.now() - startedAt },
        'diag.model_load.end',
      );

      return extractor as unknown as FeatureExtractor;
    } catch (error) {
      // Clear it, so a transient download failure does not permanently
      // poison every later call in this process.
      extractorPromise = null;

      throw new DependencyUnavailableError(
        'The local embedding model could not be loaded.',
        { model: MODEL_ID, reason: error instanceof Error ? error.message : String(error) },
      );
    }
  })();

  return extractorPromise;
}

export class LocalEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'local';
  readonly model = MODEL_ID;
  readonly dimensions = DIMENSIONS;

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    const extractor = await loadExtractor();

    // The model has a 256-token window and truncates silently past it. That is
    // acceptable — the opening of an answer carries its subject — but the
    // texts are still trimmed first so whitespace does not eat the budget.
    const prepared = texts.map((text) => text.trim().replace(/\s+/g, ' '));

    let output: { tolist(): number[][] };

    try {
      output = await extractor(prepared, { pooling: 'mean', normalize: true });
    } catch (error) {
      throw new DependencyUnavailableError('The local embedding model failed to run.', {
        model: MODEL_ID,
        batchSize: texts.length,
        reason: error instanceof Error ? error.message : String(error),
      });
    }

    const vectors = output.tolist();

    if (vectors.length !== texts.length) {
      throw new DependencyUnavailableError(
        `The embedding model returned ${vectors.length} vectors for ${texts.length} inputs.`,
        { model: MODEL_ID },
      );
    }

    // The pipeline normalises already; doing it again is cheap and means the
    // contract holds even if that option ever changes underneath us.
    return vectors.map((vector) => normalizeVector(vector));
  }
}

/** Warms the model so the first mapping call does not pay the load cost. */
export async function preloadLocalEmbeddings(): Promise<void> {
  await loadExtractor();
}
