import { getEnv } from '@/lib/config';
import { ValidationError } from '@/lib/errors';
import type { EmbeddingProvider } from './types';
import { GeminiEmbeddingProvider } from './gemini-embedding-provider';
import { LocalEmbeddingProvider } from './local-embedding-provider';

export * from './types';
export * from './cache';
export { GeminiEmbeddingProvider } from './gemini-embedding-provider';
export {
  LocalEmbeddingProvider,
  preloadLocalEmbeddings,
} from './local-embedding-provider';
export {
  FakeEmbeddingProvider,
  type FakeEmbeddingProviderOptions,
} from './fake-embedding-provider';

let providerOverride: EmbeddingProvider | null = null;

export function getEmbeddingProvider(): EmbeddingProvider {
  if (providerOverride) return providerOverride;

  const { EMBEDDING_PROVIDER, GEMINI_API_KEY } = getEnv();

  // Local by default: mapping embeds every question and every answer, and
  // that is the part of the pipeline least in need of a hosted model and most
  // likely to exhaust its quota.
  if (EMBEDDING_PROVIDER === 'local') return new LocalEmbeddingProvider();

  if (!GEMINI_API_KEY) {
    throw new ValidationError(
      'EMBEDDING_PROVIDER is "gemini" but GEMINI_API_KEY is not set. ' +
        'Set the key, or use EMBEDDING_PROVIDER=local to embed in-process.',
    );
  }

  return new GeminiEmbeddingProvider(GEMINI_API_KEY);
}

/** Test seam: inject a provider, or pass null to restore the default. */
export function setEmbeddingProvider(provider: EmbeddingProvider | null): void {
  providerOverride = provider;
}
