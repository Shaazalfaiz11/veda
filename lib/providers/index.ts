import { getAIProvider, type AIProvider } from './ai';
import { getEmbeddingProvider, type EmbeddingProvider } from './embeddings';
import { getDocumentProvider, type DocumentProvider } from './document';

export * from './ai';
export * from './embeddings';
export * from './document';

/**
 * The provider set handed to the pipeline. Stages receive this rather than
 * importing providers directly, which keeps the worker free of any vendor
 * coupling and makes every stage testable with fakes.
 */
export interface ProviderRegistry {
  ai: AIProvider;
  embeddings: EmbeddingProvider;
  documents: DocumentProvider;
}

/**
 * Providers are resolved lazily.
 *
 * The AI provider needs an API key, but most stages do not need AI at all —
 * PREPARING in particular. Constructing it eagerly would make a missing key
 * break document preparation, which is unrelated to it. Behind a getter, the
 * configuration error surfaces only when a stage actually reaches for the
 * model, and the message then points at the stage that needed it.
 */
export function getProviders(): ProviderRegistry {
  return {
    get ai() {
      return getAIProvider();
    },
    get embeddings() {
      return getEmbeddingProvider();
    },
    get documents() {
      return getDocumentProvider();
    },
  };
}
