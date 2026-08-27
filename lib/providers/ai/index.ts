import { getEnv } from '@/lib/config';
import { InternalError, ValidationError } from '@/lib/errors';
import type { AIProvider } from './types';
import { GeminiProvider } from './gemini/gemini-provider';
import { GroqProvider } from './groq/groq-provider';

export * from './types';
export { FakeAIProvider, type FakeAIProviderOptions } from './fake-ai-provider';
export {
  QUESTION_EXTRACTION_PROMPT_VERSION,
  buildQuestionExtractionPrompt,
} from './gemini/prompts';
export {
  ANSWER_EXTRACTION_PROMPT_VERSION,
  buildAnswerExtractionPrompt,
} from './gemini/answer-prompts';
export {
  GEMINI_ANSWER_SCHEMA,
  GeminiAnswerResponseSchema,
  GeminiAnswerSchema,
  GeminiAnswerRegionSchema,
} from './gemini/answer-schema';
export {
  ADJUDICATION_PROMPT_VERSION,
  buildAdjudicationPrompt,
  type AdjudicationCandidateInput,
  type AdjudicationPromptInput,
} from './gemini/adjudication-prompts';
export {
  ADJUDICATION_REASON_CODES,
  GEMINI_ADJUDICATION_SCHEMA,
  GeminiAdjudicationSchema,
} from './gemini/adjudication-schema';
export {
  GRADING_PROMPT_VERSION,
  buildGradingPrompt,
  type GradingCriterionInput,
  type GradingPromptInput,
} from './gemini/grading-prompts';
export {
  GEMINI_GRADING_SCHEMA,
  GeminiGradingSchema,
  GeminiCriterionGradeSchema,
} from './gemini/grading-schema';
export { GeminiProvider, classifyGeminiError } from './gemini/gemini-provider';
export {
  GroqProvider,
  classifyGroqResponse,
  classifyGroqTransportError,
} from './groq/groq-provider';
export {
  GROQ_ADJUDICATION_SCHEMA,
  GROQ_ANSWER_SCHEMA,
  GROQ_GRADING_SCHEMA,
  GROQ_QUESTION_SCHEMA,
} from './groq/groq-schema';
export {
  GEMINI_QUESTION_SCHEMA,
  GeminiQuestionResponseSchema,
  GeminiQuestionSchema,
} from './gemini/schema';

/**
 * Fails loudly if a stage calls a capability before it is wired, rather than
 * silently producing nothing.
 */
export const unimplementedAIProvider: AIProvider = {
  name: 'unimplemented',
  model: 'none',
  extractQuestions: () => {
    throw new InternalError('AIProvider.extractQuestions is not implemented yet.');
  },
  extractAnswers: () => {
    throw new InternalError('AIProvider.extractAnswers is not implemented yet.');
  },
  adjudicateMapping: () => {
    throw new InternalError('AIProvider.adjudicateMapping is not implemented yet.');
  },
  gradeAnswer: () => {
    throw new InternalError('AIProvider.gradeAnswer is not implemented yet.');
  },
};

let providerOverride: AIProvider | null = null;

/**
 * The provider the pipeline uses.
 *
 * Constructed per call rather than cached, so a key added to the environment
 * takes effect without a restart. If no key is configured the failure is a
 * configuration error, which the queue will not retry.
 */
export function getAIProvider(): AIProvider {
  if (providerOverride) return providerOverride;

  const { AI_PROVIDER, GEMINI_API_KEY, GROQ_API_KEY } = getEnv();

  if (AI_PROVIDER === 'groq') {
    if (!GROQ_API_KEY) {
      throw new ValidationError(
        'AI_PROVIDER is "groq" but GROQ_API_KEY is not set in .env.local.',
      );
    }

    return new GroqProvider(GROQ_API_KEY);
  }

  if (!GEMINI_API_KEY) {
    throw new ValidationError(
      'No AI provider is configured. Set GEMINI_API_KEY in .env.local to enable extraction.',
    );
  }

  return new GeminiProvider(GEMINI_API_KEY);
}

/** Test seam: inject a provider, or pass null to restore the default. */
export function setAIProvider(provider: AIProvider | null): void {
  providerOverride = provider;
}
