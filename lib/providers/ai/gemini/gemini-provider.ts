import { GoogleGenAI } from '@google/genai';
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
  GEMINI_QUESTION_SCHEMA,
  GeminiQuestionResponseSchema,
  type GeminiQuestion,
} from './schema';
import {
  QUESTION_EXTRACTION_PROMPT_VERSION,
  buildQuestionExtractionPrompt,
} from './prompts';
import {
  ANSWER_EXTRACTION_PROMPT_VERSION,
  buildAnswerExtractionPrompt,
} from './answer-prompts';
import {
  GEMINI_ANSWER_SCHEMA,
  GeminiAnswerResponseSchema,
  type GeminiAnswer,
} from './answer-schema';
import { ADJUDICATION_PROMPT_VERSION, buildAdjudicationPrompt } from './adjudication-prompts';
import { GEMINI_ADJUDICATION_SCHEMA, GeminiAdjudicationSchema } from './adjudication-schema';
import { GRADING_PROMPT_VERSION, buildGradingPrompt } from './grading-prompts';
import { GEMINI_GRADING_SCHEMA, GeminiGradingSchema } from './grading-schema';

/**
 * Gemini provider.
 *
 * Implements question extraction, answer extraction, mapping adjudication and
 * grading — every capability the pipeline currently needs.
 *
 * The provider's job stops at "parse the response into candidates". It does
 * not normalise labels, sort, deduplicate, or decide whether geometry is
 * plausible — that is the extraction service's work, and keeping it out of
 * here is what lets the service be tested without any model at all.
 *
 * There is no retry loop in this file. Failures are classified and thrown;
 * BullMQ owns retry and backoff, and a second retry mechanism nested inside
 * the first would multiply attempts rather than add resilience.
 */
export class GeminiProvider implements AIProvider {
  readonly name = 'gemini';
  readonly model: string;

  private readonly client: GoogleGenAI;
  private readonly timeoutMs: number;
  private readonly maxPages: number;
  private readonly maxOutputTokens: number;

  constructor(apiKey?: string) {
    const env = getEnv();
    const key = apiKey ?? env.GEMINI_API_KEY;

    if (!key) {
      // Configuration, not a transient fault: retrying will not find a key.
      throw new ValidationError(
        'GEMINI_API_KEY is not configured. Set it in .env.local to enable AI extraction.',
      );
    }

    this.client = new GoogleGenAI({ apiKey: key });
    this.model = env.GEMINI_MODEL;
    this.timeoutMs = env.GEMINI_TIMEOUT_MS;
    this.maxPages = env.GEMINI_MAX_PAGES_PER_REQUEST;
    this.maxOutputTokens = env.GEMINI_MAX_OUTPUT_TOKENS;
  }

  async extractQuestions(pages: PageImage[]): Promise<QuestionExtractionResult> {
    if (pages.length === 0) {
      throw new ValidationError('Question extraction needs at least one prepared page.');
    }

    if (pages.length > this.maxPages) {
      throw new InvalidDocumentError(
        `The question paper has ${pages.length} pages, exceeding the per-request limit of ${this.maxPages}.`,
        { pageCount: pages.length, maxPages: this.maxPages },
      );
    }

    const prompt = buildQuestionExtractionPrompt(pages.length);

    // Pages first, in order, then the instructions. Base64 never appears in
    // any log line — only counts and dimensions do.
    const parts = [
      ...pages.map((page) => ({
        inlineData: { mimeType: page.mimeType, data: page.data },
      })),
      { text: prompt },
    ];

    let response: Awaited<ReturnType<typeof this.client.models.generateContent>>;

    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_QUESTION_SCHEMA,
          // Extraction is a transcription task, not a creative one.
          temperature: 0,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (error) {
      throw classifyGeminiError(error, this.timeoutMs);
    }

    const text = response.text;

    if (!text || text.trim().length === 0) {
      // An empty body usually means the response was cut off or filtered —
      // worth another attempt rather than failing the run outright.
      throw new DependencyUnavailableError('Gemini returned an empty response.', {
        finishReason: response.candidates?.[0]?.finishReason ?? null,
      });
    }

    const parsed = parseQuestionResponse(text);

    return {
      candidates: parsed.map(toCandidate),
      usage: readUsage(response),
    };
  }

  /**
   * Reads a handwritten answer sheet.
   *
   * All pages go in one request so an answer continuing across a page break
   * can be recognised as a single answer. Like question extraction, the
   * provider stops at "parse the response into candidates" — ordering,
   * geometry checks and duplicate handling belong to the service.
   */
  async extractAnswers(pages: PageImage[]): Promise<AnswerExtractionResult> {
    if (pages.length === 0) {
      throw new ValidationError('Answer extraction needs at least one prepared page.');
    }

    if (pages.length > this.maxPages) {
      throw new InvalidDocumentError(
        `The answer sheet has ${pages.length} pages, exceeding the per-request limit of ${this.maxPages}.`,
        { pageCount: pages.length, maxPages: this.maxPages },
      );
    }

    const parts = [
      ...pages.map((page) => ({
        inlineData: { mimeType: page.mimeType, data: page.data },
      })),
      { text: buildAnswerExtractionPrompt(pages.length) },
    ];

    let response: Awaited<ReturnType<typeof this.client.models.generateContent>>;

    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: [{ role: 'user', parts }],
        config: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_ANSWER_SCHEMA,
          // Transcription, not composition.
          temperature: 0,
          // A whole answer sheet goes in one request, so the reply carries
          // every answer on every page. The model default is far too small
          // for that and truncates mid-object, which surfaces as unparseable
          // JSON rather than as an obvious capacity error.
          maxOutputTokens: this.maxOutputTokens,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (error) {
      throw classifyGeminiError(error, this.timeoutMs);
    }

    const text = response.text;

    if (!text || text.trim().length === 0) {
      throw new DependencyUnavailableError('Gemini returned an empty response.', {
        finishReason: response.candidates?.[0]?.finishReason ?? null,
      });
    }

    return {
      candidates: parseAnswerResponse(
        text,
        response.candidates?.[0]?.finishReason ?? null,
      ).map(toAnswerCandidate),
      usage: readUsage(response),
    };
  }

  /**
   * Checks one answer against a shortlist of candidate questions.
   *
   * The provider does not decide what the shortlist is, and does not compute
   * the final confidence — it reports what the model said, and the service
   * verifies the returned id against the candidates it actually supplied.
   */
  async adjudicateMapping(
    request: MappingAdjudicationRequest,
  ): Promise<MappingAdjudicationResult> {
    if (request.candidates.length === 0) {
      throw new ValidationError('Adjudication needs at least one candidate question.');
    }

    if (request.answerText.trim().length === 0) {
      throw new ValidationError('Adjudication needs a non-empty answer transcription.');
    }

    let response: Awaited<ReturnType<typeof this.client.models.generateContent>>;

    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: buildAdjudicationPrompt(request),
        config: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_ADJUDICATION_SCHEMA,
          temperature: 0,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (error) {
      throw classifyGeminiError(error, this.timeoutMs);
    }

    const text = response.text;

    if (!text || text.trim().length === 0) {
      throw new DependencyUnavailableError('Gemini returned an empty adjudication.', {
        finishReason: response.candidates?.[0]?.finishReason ?? null,
      });
    }

    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch {
      throw new InvalidDocumentError('Gemini returned an adjudication that was not valid JSON.');
    }

    const parsed = GeminiAdjudicationSchema.safeParse(json);

    if (!parsed.success) {
      throw new InvalidDocumentError('Gemini returned an adjudication that failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const result = parsed.data;

    return {
      decision: result.decision,
      questionId: result.decision === 'MATCH' ? result.questionId : null,
      reasonCode: result.reasonCode,
      confidence: Math.min(1, Math.max(0, result.confidence)),
      usage: readUsage(response),
    };
  }

  /**
   * Marks one answer against one question and its rubric.
   *
   * The provider stops at "parse the recommendation". Verifying the criterion
   * ids against the rubric, enforcing the ceilings and computing the total
   * are the service's work, because only it knows what was actually asked.
   */
  async gradeAnswer(request: GradingRequest): Promise<GradingResult> {
    if (request.criteria.length === 0) {
      throw new ValidationError('Grading needs at least one rubric criterion.');
    }

    if (request.answerText.trim().length === 0) {
      throw new ValidationError('Grading needs a non-empty answer transcription.');
    }

    let response: Awaited<ReturnType<typeof this.client.models.generateContent>>;

    try {
      response = await this.client.models.generateContent({
        model: this.model,
        contents: buildGradingPrompt(request),
        config: {
          responseMimeType: 'application/json',
          responseSchema: GEMINI_GRADING_SCHEMA,
          // Marking is a judgement against fixed criteria, not a creative act.
          temperature: 0,
          abortSignal: AbortSignal.timeout(this.timeoutMs),
        },
      });
    } catch (error) {
      throw classifyGeminiError(error, this.timeoutMs);
    }

    const text = response.text;

    if (!text || text.trim().length === 0) {
      throw new DependencyUnavailableError('Gemini returned an empty grading response.', {
        finishReason: response.candidates?.[0]?.finishReason ?? null,
      });
    }

    let json: unknown;

    try {
      json = JSON.parse(text);
    } catch {
      throw new InvalidDocumentError('Gemini returned grading that was not valid JSON.');
    }

    const parsed = GeminiGradingSchema.safeParse(json);

    if (!parsed.success) {
      throw new InvalidDocumentError('Gemini returned grading that failed validation.', {
        issues: parsed.error.issues.slice(0, 5).map((issue) => ({
          path: issue.path.join('.'),
          message: issue.message,
        })),
      });
    }

    const result = parsed.data;

    return {
      criteria: result.criteria.map((criterion) => ({
        criterionId: criterion.criterionId,
        awardedMarks: criterion.awardedMarks,
        reason: criterion.reason,
      })),
      totalAwardedMarks: result.totalAwardedMarks,
      confidence: Math.min(1, Math.max(0, result.confidence)),
      feedback: result.feedback,
      usage: readUsage(response),
    };
  }
}

export const GEMINI_PROMPT_VERSION = QUESTION_EXTRACTION_PROMPT_VERSION;
export const GEMINI_ANSWER_PROMPT_VERSION = ANSWER_EXTRACTION_PROMPT_VERSION;
export const GEMINI_ADJUDICATION_PROMPT_VERSION = ADJUDICATION_PROMPT_VERSION;
export const GEMINI_GRADING_PROMPT_VERSION = GRADING_PROMPT_VERSION;

/**
 * Parses the answer response body. A malformed body is permanent: the same
 * pages and prompt produce the same broken shape, so retrying wastes quota
 * and delays the real error.
 */
function parseAnswerResponse(text: string, finishReason: string | null): GeminiAnswer[] {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    // A truncated body and a malformed one both land here and look identical
    // from the message alone. The finish reason distinguishes them —
    // MAX_TOKENS means the model ran out of room mid-object, which is a
    // capacity problem, not a broken model. The tail is included because that
    // is where a truncation is visible; it is answer text, so only the last
    // few characters are kept.
    throw new InvalidDocumentError('Gemini returned a response that was not valid JSON.', {
      finishReason,
      responseChars: text.length,
      endsWith: text.slice(-24),
    });
  }

  const result = GeminiAnswerResponseSchema.safeParse(json);

  if (!result.success) {
    throw new InvalidDocumentError('Gemini returned structured output that failed validation.', {
      issues: result.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return result.data.answers;
}

function toAnswerCandidate(answer: GeminiAnswer): ExtractedAnswerCandidate {
  return {
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
  };
}

/**
 * Parses the model's JSON body.
 *
 * A malformed body is permanent, not transient: the same pages and the same
 * prompt will produce the same broken shape, so burning three queue attempts
 * on it wastes quota and delays the real error reaching the teacher.
 */
function parseQuestionResponse(text: string): GeminiQuestion[] {
  let json: unknown;

  try {
    json = JSON.parse(text);
  } catch {
    throw new InvalidDocumentError('Gemini returned a response that was not valid JSON.');
  }

  const result = GeminiQuestionResponseSchema.safeParse(json);

  if (!result.success) {
    throw new InvalidDocumentError('Gemini returned structured output that failed validation.', {
      issues: result.error.issues.slice(0, 10).map((issue) => ({
        path: issue.path.join('.'),
        message: issue.message,
      })),
    });
  }

  return result.data.questions;
}

function toCandidate(question: GeminiQuestion): ExtractedQuestionCandidate {
  return {
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
  };
}

function readUsage(response: { usageMetadata?: unknown }): ProviderUsage | null {
  const usage = response.usageMetadata as
    | { promptTokenCount?: number; candidatesTokenCount?: number; totalTokenCount?: number }
    | undefined;

  if (!usage) return null;

  return {
    promptTokens: usage.promptTokenCount ?? null,
    responseTokens: usage.candidatesTokenCount ?? null,
    totalTokens: usage.totalTokenCount ?? null,
  };
}

/**
 * Maps a transport failure onto the error taxonomy.
 *
 * The distinction that matters is retryable vs not. Rate limits, timeouts and
 * 5xx are worth another attempt with backoff; a bad key or a malformed
 * request will fail identically every time and must not consume the budget.
 */
export function classifyGeminiError(error: unknown, timeoutMs?: number): Error {
  const status = extractStatus(error);
  const message = error instanceof Error ? error.message : String(error);

  if (isAbortError(error)) {
    return new DependencyUnavailableError(
      `Gemini did not respond within ${timeoutMs ?? 'the configured'} ms.`,
    );
  }

  if (status === 429) {
    // Google returns 429 for two very different conditions: a per-minute
    // burst limit that clears in seconds, and a per-day quota that does not
    // clear until tomorrow. The status is identical; only the message says
    // which, and without it there is no way to know whether waiting helps.
    return new DependencyUnavailableError('Gemini rate limit exceeded.', {
      status,
      providerMessage: message.slice(0, 300),
    });
  }

  if (status !== null && status >= 500) {
    // Carry the provider's own wording through: "the model is overloaded"
    // and "internal error" are the same status but different problems, and
    // the status alone cannot tell them apart. Truncated, because it is a
    // provider string and nothing here needs an unbounded one.
    return new DependencyUnavailableError('Gemini is temporarily unavailable.', {
      status,
      providerMessage: message.slice(0, 200),
    });
  }

  if (status === 401 || status === 403) {
    // Log without the key; the message itself never carries it.
    logger.error({ status }, 'gemini.auth_failed');
    return new ValidationError('Gemini rejected the API key.', { status });
  }

  if (status !== null && status >= 400) {
    return new InvalidDocumentError('Gemini rejected the extraction request.', { status });
  }

  if (isNetworkError(message)) {
    return new DependencyUnavailableError('Could not reach Gemini.', { reason: message });
  }

  // Unknown: treated as transient so a genuine blip is not discarded.
  return new DependencyUnavailableError('Gemini request failed.', { reason: message });
}

function extractStatus(error: unknown): number | null {
  if (typeof error !== 'object' || error === null) return null;

  const candidate = error as { status?: unknown; code?: unknown; message?: unknown };

  if (typeof candidate.status === 'number') return candidate.status;
  if (typeof candidate.code === 'number') return candidate.code;

  // The SDK often folds the status into the message text.
  if (typeof candidate.message === 'string') {
    const match = /\b(4\d{2}|5\d{2})\b/.exec(candidate.message);
    if (match) return Number.parseInt(match[1]!, 10);
  }

  return null;
}

function isAbortError(error: unknown): boolean {
  if (typeof error !== 'object' || error === null) return false;
  const name = (error as { name?: unknown }).name;
  return name === 'AbortError' || name === 'TimeoutError';
}

function isNetworkError(message: string): boolean {
  return /ECONNRESET|ENOTFOUND|ETIMEDOUT|ECONNREFUSED|EAI_AGAIN|fetch failed|network/i.test(
    message,
  );
}
