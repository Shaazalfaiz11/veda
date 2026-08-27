import { GoogleGenAI } from '@google/genai';
import { getEnv } from '@/lib/config';
import { DependencyUnavailableError, InvalidDocumentError, ValidationError } from '@/lib/errors';
import { classifyGeminiError } from '@/lib/providers/ai/gemini/gemini-provider';
import { normalizeVector, type EmbeddingProvider } from './types';

/**
 * Gemini embeddings.
 *
 * Vectors are requested at a reduced dimensionality and re-normalised here,
 * which the model's truncation requires and which also makes cosine
 * similarity a plain dot product downstream.
 *
 * No retry loop: failures are classified and thrown, and BullMQ owns retry —
 * the same rule as every other provider in this codebase.
 */
export class GeminiEmbeddingProvider implements EmbeddingProvider {
  readonly name = 'gemini';
  readonly model: string;
  readonly dimensions: number;

  private readonly client: GoogleGenAI;
  private readonly timeoutMs: number;

  constructor(apiKey?: string) {
    const env = getEnv();
    const key = apiKey ?? env.GEMINI_API_KEY;

    if (!key) {
      throw new ValidationError(
        'GEMINI_API_KEY is not configured. Set it in .env.local to enable semantic mapping.',
      );
    }

    this.client = new GoogleGenAI({ apiKey: key });
    this.model = env.GEMINI_EMBEDDING_MODEL;
    this.dimensions = env.GEMINI_EMBEDDING_DIMENSIONS;
    this.timeoutMs = env.GEMINI_TIMEOUT_MS;
  }

  async embed(texts: readonly string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    if (texts.some((text) => text.trim().length === 0)) {
      throw new ValidationError('Cannot embed an empty string.');
    }

    let response: Awaited<ReturnType<typeof this.client.models.embedContent>>;

    try {
      response = await this.client.models.embedContent({
        model: this.model,
        contents: [...texts],
        config: {
          taskType: 'SEMANTIC_SIMILARITY',
          outputDimensionality: this.dimensions,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (error) {
      throw classifyGeminiError(error, this.timeoutMs);
    }

    const embeddings = response.embeddings ?? [];

    if (embeddings.length !== texts.length) {
      // A short batch would silently misalign every vector with its text.
      throw new DependencyUnavailableError(
        `Embedding provider returned ${embeddings.length} vectors for ${texts.length} texts.`,
      );
    }

    return embeddings.map((embedding, index) => {
      const values = embedding.values;

      if (!values || values.length === 0) {
        throw new DependencyUnavailableError(`Embedding ${index} came back empty.`);
      }

      if (values.length !== this.dimensions) {
        // Permanent: the configured dimensionality does not match reality, and
        // retrying produces the same mismatch.
        throw new InvalidDocumentError(
          `Embedding ${index} has ${values.length} dimensions, expected ${this.dimensions}.`,
        );
      }

      return normalizeVector(values);
    });
  }
}
