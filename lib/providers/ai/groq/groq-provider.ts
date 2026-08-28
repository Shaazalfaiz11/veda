import sharp from '@/lib/config/sharp-runtime';
import { getEnv } from '@/lib/config';
import {
  DependencyUnavailableError,
  InvalidDocumentError,
  ValidationError,
} from '@/lib/errors';
import { logger } from '@/lib/logger';
import type {
  AIProvider,
  AnswerExtractionResult,
  ExtractedAnswerCandidate,
  ExtractedQuestionCandidate,
  GradingRequest,
  GradingResult,
  MappingAdjudicationRequest,
  MappingAdjudicationResult,
  PageImage,
  ProviderUsage,
  QuestionExtractionResult,
} from '../types';
import {
  ANSWER_EXTRACTION_PROMPT_VERSION,
  buildAnswerExtractionPrompt,
} from '../gemini/answer-prompts';
import { buildQuestionExtractionPrompt } from '../gemini/prompts';
import { buildAdjudicationPrompt } from '../gemini/adjudication-prompts';
import { buildGradingPrompt } from '../gemini/grading-prompts';
import { GeminiAnswerResponseSchema } from '../gemini/answer-schema';
import { GeminiQuestionResponseSchema } from '../gemini/schema';
import { GeminiAdjudicationSchema } from '../gemini/adjudication-schema';
import { GeminiGradingSchema } from '../gemini/grading-schema';
import {
  getGroqRateLimiter,
  readRateLimitHeaders,
} from './rate-limiter';
import {
  GROQ_ADJUDICATION_SCHEMA,
  GROQ_ANSWER_SCHEMA,
  GROQ_GRADING_SCHEMA,
  GROQ_QUESTION_SCHEMA,
  type JsonSchema,
} from './groq-schema';

/**
 * Groq implementation of the AI provider contract.
 *
 * Same four methods, same inputs, same result types. The pipeline cannot tell
 * which provider it is talking to, which is the point — the extraction,
 * mapping and grading services are untouched by this file's existence.
 *
 * Two things differ materially from the Gemini implementation, and both are
 * why this provider exists at all:
 *
 * **Strict schemas.** Groq constrains decoding against a JSON Schema, so a
 * response cannot be malformed. The truncated, unparseable replies that made
 * long answer sheets unreliable on the other provider are structurally
 * impossible here.
 *
 * **Reasoning must be switched off.** Qwen3 reasons by default and spends the
 * completion budget doing it, returning an empty body and a `400
 * json_validate_failed` whose message points at JSON rather than at the cause.
 * `reasoning_effort: 'none'` is therefore not a tuning choice; without it
 * every call fails.
 *
 * The prompts are shared with the Gemini provider unchanged. They describe the
 * task, not the vendor, so duplicating them would only create two things to
 * keep in step.
 */

const ENDPOINT = 'https://api.groq.com/openai/v1/chat/completions';

/**
 * Cost of one page image, and the margin left unclaimed.
 *
 * Measured against the live API: one page image plus a short prompt reports
 * ~1,841 prompt tokens, so ~2,100 is the figure with a little slack. The
 * headroom absorbs the difference between our estimate and the provider's.
 */
const IMAGE_TOKENS = 2_100;
const HEADROOM = 600;

interface ChatContent {
  type: 'text' | 'image_url';
  text?: string;
  image_url?: { url: string };
}

interface ChatResponse {
  choices?: Array<{ message?: { content?: string }; finish_reason?: string }>;
  usage?: {
    prompt_tokens?: number;
    completion_tokens?: number;
    total_tokens?: number;
  };
}

export class GroqProvider implements AIProvider {
  readonly name = 'groq';
  readonly model: string;

  private readonly apiKey: string;
  private readonly timeoutMs: number;
  private readonly maxOutputTokens: number;
  private readonly maxOutputTokensAdjudication: number;
  private readonly maxOutputTokensGrading: number;
  private readonly maxImages: number;
  private readonly imageMaxDimension: number;
  private readonly tpmBudget: number;

  constructor(apiKey?: string) {
    const env = getEnv();
    const key = apiKey ?? env.GROQ_API_KEY;

    if (!key) {
      throw new ValidationError(
        'No Groq API key is configured. Set GROQ_API_KEY in .env.local.',
      );
    }

    this.apiKey = key;
    this.model = env.GROQ_MODEL;
    this.timeoutMs = env.GROQ_TIMEOUT_MS;
    this.maxOutputTokens = env.GROQ_MAX_OUTPUT_TOKENS;
    this.maxOutputTokensAdjudication = env.GROQ_MAX_OUTPUT_TOKENS_ADJUDICATION;
    this.maxOutputTokensGrading = env.GROQ_MAX_OUTPUT_TOKENS_GRADING;
    this.maxImages = env.GROQ_MAX_IMAGES_PER_REQUEST;
    this.imageMaxDimension = env.GROQ_IMAGE_MAX_DIMENSION;
    this.tpmBudget = env.GROQ_TPM_BUDGET;
  }

  async extractQuestions(pages: PageImage[]): Promise<QuestionExtractionResult> {
    this.assertImageCount(pages.length);

    const { json, usage } = await this.call({
      schemaName: 'questions',
      schema: GROQ_QUESTION_SCHEMA,
      prompt: buildQuestionExtractionPrompt(pages.length),
      pages,
    });

    const result = GeminiQuestionResponseSchema.safeParse(json);

    if (!result.success) {
      throw new InvalidDocumentError('Groq returned questions that failed validation.', {
        issues: result.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const candidates: ExtractedQuestionCandidate[] = result.data.questions.map((question) => ({
      labelRaw: question.labelRaw,
      text: question.text,
      marks: question.marks,
      pageNumber: question.pageNumber,
      rects: question.rects.map((rect) => ({
        pageNumber: rect.rectPageNumber,
        x: rect.x,
        y: rect.y,
        width: rect.width,
        height: rect.height,
      })),
    }));

    return { candidates, usage };
  }

  async extractAnswers(pages: PageImage[]): Promise<AnswerExtractionResult> {
    this.assertImageCount(pages.length);

    const { json, usage } = await this.call({
      schemaName: 'answers',
      schema: GROQ_ANSWER_SCHEMA,
      prompt: buildAnswerExtractionPrompt(pages.length),
      pages,
    });

    const result = GeminiAnswerResponseSchema.safeParse(json);

    if (!result.success) {
      throw new InvalidDocumentError('Groq returned answers that failed validation.', {
        issues: result.error.issues.slice(0, 10).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const candidates: ExtractedAnswerCandidate[] = result.data.answers.map((answer) => ({
      claimedLabelRaw: answer.claimedLabelRaw,
      text: answer.text,
      regions: answer.regions.map((region) => ({
        pageNumber: region.pageNumber,
        x: region.x,
        y: region.y,
        width: region.width,
        height: region.height,
        kind: region.kind,
      })),
    }));

    return { candidates, usage };
  }

  async adjudicateMapping(
    request: MappingAdjudicationRequest,
  ): Promise<MappingAdjudicationResult> {
    const { json, usage } = await this.call({
      schemaName: 'adjudication',
      schema: GROQ_ADJUDICATION_SCHEMA,
      prompt: buildAdjudicationPrompt({
        answerText: request.answerText,
        claimedLabelRaw: request.claimedLabelRaw,
        candidates: request.candidates,
      }),
      pages: [],
      maxOutputTokens: this.maxOutputTokensAdjudication,
    });

    const result = GeminiAdjudicationSchema.safeParse(json);

    if (!result.success) {
      throw new InvalidDocumentError('Groq returned an adjudication that failed validation.', {
        issues: result.error.issues.slice(0, 5).map((issue) => issue.message),
      });
    }

    return {
      decision: result.data.decision,
      questionId: result.data.questionId,
      reasonCode: result.data.reasonCode,
      confidence: result.data.confidence,
      usage,
    };
  }

  async gradeAnswer(request: GradingRequest): Promise<GradingResult> {
    const { json, usage } = await this.call({
      schemaName: 'grading',
      schema: GROQ_GRADING_SCHEMA,
      prompt: buildGradingPrompt(request),
      pages: [],
      maxOutputTokens: this.maxOutputTokensGrading,
    });

    const result = GeminiGradingSchema.safeParse(json);

    if (!result.success) {
      throw new InvalidDocumentError('Groq returned grading that failed validation.', {
        issues: result.error.issues.slice(0, 5).map((issue) => issue.message),
      });
    }

    return {
      criteria: result.data.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        awardedMarks: criterion.awardedMarks,
        reason: criterion.reason,
      })),
      totalAwardedMarks: result.data.totalAwardedMarks,
      confidence: result.data.confidence,
      feedback: result.data.feedback,
      usage,
    };
  }

  /**
   * Refuses a batch the model cannot see in one request.
   *
   * Silently dropping the surplus would lose pages without saying so, and an
   * answer sheet quietly missing its last page is worse than a failed run.
   * The caller chunks; this is the guard that proves it did.
   */
  private assertImageCount(count: number): void {
    if (count > this.maxImages) {
      throw new ValidationError(
        `${count} page images were sent, exceeding the per-request limit of ${this.maxImages}.`,
        { count, maxImages: this.maxImages },
      );
    }
  }

  /**
   * The page as a data URL, downscaled to fit the token budget.
   *
   * Images are charged in tiles, so a 2000px prepared page costs several
   * thousand tokens and two of them alone exceed the per-minute limit. Only
   * the copy sent to the model shrinks — the stored bitmap the teacher sees,
   * and every normalized coordinate measured against it, are untouched.
   *
   * A page already inside the limit is passed through as-is rather than
   * re-encoded, which would cost time and a generation of quality for nothing.
   */
  private async forRequest(page: PageImage): Promise<string> {
    const longestEdge = Math.max(page.width, page.height);

    // Decode only on the path that resizes. Decoding first cost a full-size
    // buffer even for a page that was about to be passed through untouched.
    if (longestEdge > 0 && longestEdge <= this.imageMaxDimension) {
      return `data:${page.mimeType};base64,${page.data}`;
    }

    try {
      const resized = await sharp(Buffer.from(page.data, 'base64'))
        .resize({
          width: this.imageMaxDimension,
          height: this.imageMaxDimension,
          fit: 'inside',
          withoutEnlargement: true,
        })
        // JPEG rather than PNG: handwriting survives it, and the payload is a
        // fraction of the size, which matters against a request-size limit.
        .jpeg({ quality: 82 })
        .toBuffer();

      return `data:image/jpeg;base64,${resized.toString('base64')}`;
    } catch {
      // Downscaling is an optimisation. If it fails, the original still has a
      // chance of fitting, and a hard failure here would be worse.
      return `data:${page.mimeType};base64,${page.data}`;
    }
  }

  /**
   * How many output tokens to reserve for this request.
   *
   * The provider charges input plus the *reserved* output against one
   * per-minute ceiling, so the reservation has to be whatever the images and
   * prompt leave behind. A fixed number cannot work: the size that fits two
   * dense pages is refused outright, and the size that is always accepted
   * truncates a page carrying twenty questions.
   *
   * Images are ~2,048 tokens each; the small margin above that, and the
   * headroom subtracted at the end, cover the rolling window still holding
   * tokens from the previous request.
   */
  private outputBudgetFor(imageCount: number, prompt: string, ceiling: number): number {
    const promptTokens = Math.ceil(prompt.length / 4);
    const available =
      this.tpmBudget - imageCount * IMAGE_TOKENS - promptTokens - HEADROOM;

    // Never below a floor: a reservation too small to hold one answer would
    // truncate every time, which is worse than being refused.
    return Math.max(1_000, Math.min(ceiling, available));
  }

  /**
   * What this request will cost the per-minute budget.
   *
   * Input plus the reservation, which is what the provider charges at
   * admission. The limiter schedules against this and then replaces it with
   * the figure the response reports.
   */
  private estimateFor(imageCount: number, prompt: string, reserved: number): number {
    return imageCount * IMAGE_TOKENS + Math.ceil(prompt.length / 4) + reserved;
  }

  private async call(input: {
    schemaName: string;
    schema: JsonSchema;
    prompt: string;
    pages: PageImage[];
    /** Reservation ceiling for this kind of call. Defaults to the global one. */
    maxOutputTokens?: number;
  }): Promise<{ json: unknown; usage: ProviderUsage | null }> {
    const scaled = await Promise.all(input.pages.map((page) => this.forRequest(page)));

    const content: ChatContent[] = [
      ...scaled.map((url): ChatContent => ({ type: 'image_url', image_url: { url } })),
      { type: 'text', text: input.prompt },
    ];

    const reserved = this.outputBudgetFor(
      input.pages.length,
      input.prompt,
      input.maxOutputTokens ?? this.maxOutputTokens,
    );

    const body = {
      model: this.model,
      temperature: 0,
      max_completion_tokens: reserved,
      // Mandatory. Qwen3 otherwise spends the whole budget reasoning and
      // returns an empty body.
      reasoning_effort: 'none',
      response_format: {
        type: 'json_schema',
        json_schema: { name: input.schemaName, strict: true, schema: input.schema },
      },
      messages: [{ role: 'user', content }],
    };

    /*
     * Wait for room in the shared per-minute budget before sending.
     *
     * This is the only pacing in the pipeline. The stages used to sleep a
     * fixed interval each, which neither knew what the other stages had spent
     * nor what this particular request would cost.
     */
    const limiter = getGroqRateLimiter();
    const settle = await limiter.acquire(
      this.estimateFor(input.pages.length, input.prompt, reserved),
      input.schemaName,
    );

    let response: Response;

    try {
      response = await fetch(ENDPOINT, {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${this.apiKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (error) {
      settle(null, { limitTokens: null, remainingTokens: null, resetTokensMs: null });
      throw classifyGroqTransportError(error, this.timeoutMs);
    }

    const headers = readRateLimitHeaders(response);

    if (!response.ok) {
      const error = await classifyGroqResponse(response);

      // A refusal means the window is genuinely full, whatever we counted.
      // Hold every caller off for as long as Groq asked rather than letting
      // the next one walk into the same wall.
      if (response.status === 429) {
        const retryAfterMs = (error as { details?: { retryAfterMs?: number } }).details
          ?.retryAfterMs;
        limiter.penalise(retryAfterMs ?? headers.resetTokensMs ?? null);
      }

      settle(null, headers);
      throw error;
    }

    const parsed = (await response.json()) as ChatResponse;
    settle(parsed.usage?.total_tokens ?? null, headers);
    const text = parsed.choices?.[0]?.message?.content;

    if (!text || text.trim().length === 0) {
      throw new DependencyUnavailableError('Groq returned an empty response.', {
        finishReason: parsed.choices?.[0]?.finish_reason ?? null,
      });
    }

    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch {
      // Strict decoding should make this unreachable; if it happens the body
      // is the evidence, so the tail is kept.
      throw new InvalidDocumentError('Groq returned a response that was not valid JSON.', {
        finishReason: parsed.choices?.[0]?.finish_reason ?? null,
        responseChars: text.length,
        endsWith: text.slice(-24),
      });
    }

    return { json, usage: readUsage(parsed) };
  }
}

function readUsage(response: ChatResponse): ProviderUsage | null {
  if (!response.usage) return null;

  return {
    promptTokens: response.usage.prompt_tokens ?? null,
    responseTokens: response.usage.completion_tokens ?? null,
    totalTokens: response.usage.total_tokens ?? null,
  };
}

/**
 * Maps an HTTP failure onto the error taxonomy.
 *
 * The distinction that matters is retryable versus not: a rate limit or a 5xx
 * is worth another attempt, a bad key or a malformed request will fail
 * identically every time and must not spend the budget. `Retry-After` is
 * carried through when present so the caller can wait the time the service
 * actually asked for.
 */
export async function classifyGroqResponse(response: Response): Promise<Error> {
  const status = response.status;
  const retryAfter = readRetryAfterMs(response);

  let providerMessage = '';
  try {
    providerMessage = (await response.text()).slice(0, 300);
  } catch {
    providerMessage = '';
  }

  if (status === 429) {
    return new DependencyUnavailableError('Groq rate limit exceeded.', {
      status,
      retryAfterMs: retryAfter,
      providerMessage,
    });
  }

  if (status >= 500) {
    return new DependencyUnavailableError('Groq is temporarily unavailable.', {
      status,
      retryAfterMs: retryAfter,
      providerMessage,
    });
  }

  if (status === 401 || status === 403) {
    // Logged without the key; the message never carries it.
    logger.error({ status }, 'groq.auth_failed');
    return new ValidationError('Groq rejected the API key.', { status });
  }

  if (status === 400) {
    return new InvalidDocumentError('Groq rejected the request.', {
      status,
      providerMessage,
    });
  }

  return new InvalidDocumentError(`Groq returned an unexpected status ${status}.`, {
    status,
    providerMessage,
  });
}

export function classifyGroqTransportError(error: unknown, timeoutMs: number): Error {
  const message = error instanceof Error ? error.message : String(error);

  if (error instanceof Error && (error.name === 'TimeoutError' || error.name === 'AbortError')) {
    return new DependencyUnavailableError(`Groq did not respond within ${timeoutMs} ms.`);
  }

  // A socket-level failure is transient by default: discarding a run because
  // the network blipped is worse than one more attempt.
  return new DependencyUnavailableError('Could not reach Groq.', { reason: message });
}

/** `Retry-After` in seconds, or a Groq `x-ratelimit-reset-*` duration. */
function readRetryAfterMs(response: Response): number | null {
  const header = response.headers.get('retry-after');

  if (header) {
    const seconds = Number.parseFloat(header);
    if (Number.isFinite(seconds)) return Math.round(seconds * 1000);
  }

  const reset = response.headers.get('x-ratelimit-reset-tokens');
  if (!reset) return null;

  // Groq reports these as durations like "19.65s" or "2m52.8s".
  const match = /^(?:(\d+)m)?([\d.]+)s$/.exec(reset.trim());
  if (!match) return null;

  const minutes = Number.parseInt(match[1] ?? '0', 10);
  const seconds = Number.parseFloat(match[2] ?? '0');

  return Math.round((minutes * 60 + seconds) * 1000);
}

export const GROQ_ANSWER_PROMPT_VERSION = ANSWER_EXTRACTION_PROMPT_VERSION;
