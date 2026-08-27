import { z } from 'zod';

/**
 * Environment contract. Parsed lazily so that importing this module never
 * throws at import time — tests and tooling can load the app without a
 * fully populated environment.
 */
const EnvSchema = z.object({
  NODE_ENV: z
    .enum(['development', 'test', 'production'])
    .default('development'),

  REDIS_URL: z.string().min(1, 'REDIS_URL is required'),
  REDIS_KEY_PREFIX: z.string().min(1).default('veda'),

  WORKER_CONCURRENCY: z.coerce.number().int().positive().default(2),
  JOB_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(10).default(3),
  JOB_BACKOFF_MS: z.coerce.number().int().positive().default(1000),
  ASSESSMENT_TTL_SECONDS: z.coerce.number().int().positive().default(86_400),

  LOG_LEVEL: z
    .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
    .default('info'),

  // --- Document ingestion -------------------------------------------------
  /** Root of the local document store. Never exposed through the API. */
  STORAGE_ROOT: z.string().min(1).default('.storage'),

  /** Hard ceiling on an uploaded file, in bytes. Default 10 MB. */
  MAX_DOCUMENT_BYTES: z.coerce.number().int().positive().default(10 * 1024 * 1024),

  /** Refuse documents longer than this, to bound preparation cost. */
  MAX_DOCUMENT_PAGES: z.coerce.number().int().positive().max(500).default(50),

  /**
   * Longest edge of a prepared page bitmap, in pixels. Pages are rendered to
   * fit this box; the scale applied is recorded on each prepared page so the
   * transformation from source geometry stays explicit.
   */
  PREPARED_PAGE_MAX_DIMENSION: z.coerce.number().int().min(256).max(8192).default(2000),

  // --- Gemini -------------------------------------------------------------
  /**
   * Server-only. Optional so that lint, typecheck, build and the offline test
   * suite never depend on a credential; the provider fails with a clear
   * configuration error if it is actually invoked without one.
   */
  GEMINI_API_KEY: z.preprocess(
    // A blank line in .env means "not set" — which is exactly what copying
    // .env.example produces. Without this an empty string is present but
    // invalid, and every command fails at config load.
    (value) => (typeof value === 'string' && value.trim() === '' ? undefined : value),
    z.string().min(1).optional(),
  ),

  /** Centralised so a model name never appears inline anywhere else. */
  GEMINI_MODEL: z.string().min(1).default('gemini-3.6-flash'),

  /** Per-request ceiling. A hung call must not hold a queue slot forever. */
  GEMINI_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),

  /** Upper bound on pages sent in one extraction request. */
  GEMINI_MAX_PAGES_PER_REQUEST: z.coerce.number().int().positive().max(100).default(20),

  /**
   * Ceiling on a single response. Answer extraction sends a whole sheet in
   * one request, so its reply grows with the page count; the model default is
   * small enough that a long sheet is truncated mid-object and arrives as
   * unparseable JSON.
   */
  GEMINI_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(200_000).default(65_536),

  /**
   * Answer extraction sends the sheet as overlapping page chunks rather than
   * in one request, because a long sheet exceeds what the model will return
   * in one piece. The overlap is what keeps an answer that runs onto the next
   * page recognisable as one answer: a span of up to `overlap + 1` pages is
   * guaranteed to sit wholly inside some chunk.
   */
  ANSWER_CHUNK_PAGES: z.coerce.number().int().min(1).max(50).default(4),
  ANSWER_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(49).default(1),

  /** Pacing between chunk requests, for rate-limited tiers. */
  /**
   * Pacing between chunk requests. The ceiling is generous because the
   * binding constraint on a vision provider is tokens per minute, not
   * requests: three page images plus a prompt is most of a minute's budget,
   * so a chunked sheet has to be spread across minutes rather than seconds.
   */
  ANSWER_CHUNK_DELAY_MS: z.coerce.number().int().min(0).max(180_000).default(250),

  /**
   * Attempts per chunk before it is recorded as lost. Retrying one chunk in
   * place is far cheaper than letting the queue retry the job, which would
   * re-read every chunk that already succeeded.
   */
  ANSWER_CHUNK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(2),

  /**
   * Question papers are chunked for the same reason answer sheets are: a
   * vision provider caps images per request. The default matches the answer
   * chunk so one provider limit governs both.
   */
  QUESTION_CHUNK_PAGES: z.coerce.number().int().min(1).max(50).default(20),
  QUESTION_CHUNK_OVERLAP: z.coerce.number().int().min(0).max(49).default(1),
  QUESTION_CHUNK_DELAY_MS: z.coerce.number().int().min(0).max(180_000).default(250),
  QUESTION_CHUNK_MAX_ATTEMPTS: z.coerce.number().int().min(1).max(5).default(3),
  /** Base wait between chunk attempts; quadruples each time. Zero in tests. */
  QUESTION_CHUNK_BACKOFF_MS: z.coerce.number().int().min(0).max(60_000).default(5_000),

  /** Embedding model, centralised alongside the generation model. */
  GEMINI_EMBEDDING_MODEL: z.string().min(1).default('gemini-embedding-001'),

  /**
   * Output dimensionality. The model emits 3072 by default; 768 keeps memory
   * and comparison cost down with no measurable loss on assessment-sized
   * text. Vectors are re-normalised after truncation.
   */
  GEMINI_EMBEDDING_DIMENSIONS: z.coerce.number().int().min(128).max(3072).default(768),

  /**
   * Where the semantic signal for mapping comes from.
   *
   * `local` runs a sentence-transformer in this process: no API key, no
   * request budget, and mapping stops competing for the same quota as the
   * stages that genuinely need a large model. `gemini` keeps the hosted
   * provider for anyone who prefers it.
   */
  EMBEDDING_PROVIDER: z.enum(['local', 'gemini']).default('local'),

  // ---------------------------------------------------------------------
  // Groq (server/worker only — never exposed to the browser)
  // ---------------------------------------------------------------------
  /** Which provider serves generation and vision. Gemini stays selectable. */
  AI_PROVIDER: z.enum(['gemini', 'groq']).default('gemini'),

  GROQ_API_KEY: z
    .string()
    .trim()
    .optional()
    .transform((value) => (value && value.length > 0 ? value : undefined)),

  /**
   * `qwen/qwen3.8-27b` is the vision model that supports **strict** JSON
   * schema, so decoding is constrained and a malformed reply is impossible.
   * It allows fewer images per request than its sibling, which costs nothing
   * because the token-per-minute budget binds first.
   */
  GROQ_MODEL: z.string().min(1).default('qwen/qwen3.8-27b'),

  GROQ_TIMEOUT_MS: z.coerce.number().int().positive().default(120_000),
  /**
   * Reserved output budget per request.
   *
   * Groq charges the *reserved* completion budget against tokens-per-minute,
   * not the tokens actually produced. An 8,192 reservation therefore consumed
   * most of an 8,000/minute allowance on its own and every vision request was
   * refused with a 413 before it began. Sized instead to what a chunk's worth
   * of answers actually needs.
   */
  GROQ_MAX_OUTPUT_TOKENS: z.coerce.number().int().positive().max(64_000).default(2_500),

  /**
   * Hard ceiling on images in one request. A page image costs roughly 1,600
   * tokens, so three plus a prompt sits just inside the 8,000/minute budget
   * this tier allows — the real constraint, tighter than the API's own limit.
   */
  /**
   * Completion budgets, per kind of call.
   *
   * These are charged against the per-minute budget at admission, not on
   * return, so a ceiling far above what a call can produce is spent whether it
   * is used or not. Measured on a real run: an adjudication replies in about
   * 80 tokens and a grade in about 350, against the 2,500 both were reserving
   * — 2.4K and 2.2K wasted on every call. Each is set to several times its
   * observed maximum, which is headroom for an unusual answer without
   * reserving a stage's worth of budget for a sentence.
   */
  GROQ_MAX_OUTPUT_TOKENS_ADJUDICATION: z.coerce.number().int().positive().default(400),
  GROQ_MAX_OUTPUT_TOKENS_GRADING: z.coerce.number().int().positive().default(1_200),

  GROQ_MAX_IMAGES_PER_REQUEST: z.coerce.number().int().min(1).max(5).default(3),

  /**
   * Longest edge of a page image *as sent to Groq*.
   *
   * Image cost is charged in tiles, so a full-resolution prepared page costs
   * several thousand tokens and two of them exceed the whole per-minute
   * budget. Downscaling only the copy that goes to the model keeps three
   * pages per request affordable; the stored canonical bitmap is untouched,
   * so the viewer and every normalized coordinate stay exactly as they were.
   */
  GROQ_IMAGE_MAX_DIMENSION: z.coerce.number().int().min(256).max(2_000).default(1_024),

  /**
   * Tokens-per-minute allowance to plan a request against.
   *
   * Groq charges input *and* the reserved output budget against one ceiling,
   * so the two cannot be tuned independently. Reserving a fixed output size
   * fails in both directions: too large and the request is refused before it
   * starts, too small and a dense page truncates mid-object. The provider
   * derives what is left after the images instead, which is why this is the
   * limit rather than an output size.
   */
  GROQ_TPM_BUDGET: z.coerce.number().int().min(1_000).max(1_000_000).default(8_000),

  // --- Mapping ------------------------------------------------------------
  /** Candidates per answer that reach LLM adjudication. */
  MAPPING_TOP_K: z.coerce.number().int().positive().max(10).default(3),

  /**
   * Candidate-generation weights. These are engineering heuristics, not
   * optimal values — they are here to be tuned against measured results.
   * They must sum to 1 so the candidate score stays on a 0-1 scale.
   */
  MAPPING_WEIGHT_LABEL: z.coerce.number().min(0).max(1).default(0.45),
  MAPPING_WEIGHT_SEMANTIC: z.coerce.number().min(0).max(1).default(0.35),
  MAPPING_WEIGHT_POSITION: z.coerce.number().min(0).max(1).default(0.1),
  MAPPING_WEIGHT_STRUCTURE: z.coerce.number().min(0).max(1).default(0.1),

  /** How much the adjudicator moves the final confidence. */
  MAPPING_WEIGHT_LLM: z.coerce.number().min(0).max(1).default(0.3),

  /** Subtracted when an answer's written label contradicts the question's. */
  MAPPING_LABEL_CONFLICT_PENALTY: z.coerce.number().min(0).max(1).default(0.25),

  /**
   * Cosine similarity below which two exam texts are considered unrelated.
   * Everything in one paper shares vocabulary, so raw cosine has a high
   * floor (~0.65-0.70 for unrelated pairs) and cannot be used as a score
   * directly.
   */
  MAPPING_SEMANTIC_FLOOR: z.coerce.number().min(0).max(1).default(0.65),

  /**
   * Confidence bands. Business heuristics, not mathematical truths.
   */
  MAPPING_CONFIDENCE_HIGH: z.coerce.number().min(0).max(1).default(0.9),
  MAPPING_CONFIDENCE_MEDIUM: z.coerce.number().min(0).max(1).default(0.7),

  /** Below this, a pair is not worth assigning at all. */
  MAPPING_MIN_ASSIGNMENT_SCORE: z.coerce.number().min(0).max(1).default(0.35),

  /**
   * Candidate score above which an exact label match is treated as decisive
   * and adjudication is skipped.
   *
   * The adjudicator exists to break ties the cheap signals cannot. When the
   * student wrote "Q4", the paper has exactly one Q4, and the content agrees,
   * there is no tie to break — spending a model call there buys nothing and
   * competes for the same rate limit as the ambiguous cases that need it.
   * Set to 1 to adjudicate everything.
   */
  MAPPING_SKIP_ADJUDICATION_ABOVE: z.coerce.number().min(0).max(1).default(0.93),

  /**
   * Pause between adjudication calls, for rate-limited tiers.
   *
   * The ceiling matches the chunk delays. A free tier metered per minute needs
   * gaps measured in tens of seconds — a 10s cap could not express the pacing
   * the provider actually requires, and the stage failed rather than waiting.
   */
  MAPPING_ADJUDICATION_DELAY_MS: z.coerce.number().int().min(0).max(180_000).default(250),

  // --- Grading ------------------------------------------------------------
  /**
   * Grading confidence weights. Engineering heuristics for deciding what a
   * human should look at, not a calibrated probability. They must sum to 1 so
   * the result stays on a 0-1 scale.
   */
  GRADING_WEIGHT_RUBRIC: z.coerce.number().min(0).max(1).default(0.3),
  GRADING_WEIGHT_TRANSCRIPTION: z.coerce.number().min(0).max(1).default(0.25),
  GRADING_WEIGHT_MODEL: z.coerce.number().min(0).max(1).default(0.3),
  GRADING_WEIGHT_CRITERION: z.coerce.number().min(0).max(1).default(0.15),

  /** Below this a grade is flagged for review rather than applied unattended. */
  GRADING_CONFIDENCE_THRESHOLD: z.coerce.number().min(0).max(1).default(0.75),

  /** Whether half marks are permitted. Whole marks unless stated otherwise. */
  GRADING_MARK_GRANULARITY: z.enum(['WHOLE', 'HALF']).default('WHOLE'),

  /** Pause between grading calls, for rate-limited tiers. */
  GRADING_CALL_DELAY_MS: z.coerce.number().int().min(0).max(10_000).default(250),
})
  .superRefine((env, ctx) => {
    // Overlap at or above the chunk size means the chunk walk never advances,
    // so the sheet would never be fully covered. Caught at startup rather
    // than as a hang partway through a real extraction.
    if (env.ANSWER_CHUNK_OVERLAP >= env.ANSWER_CHUNK_PAGES) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['ANSWER_CHUNK_OVERLAP'],
        message:
          `Chunk overlap (${env.ANSWER_CHUNK_OVERLAP}) must be smaller than the chunk ` +
          `size (${env.ANSWER_CHUNK_PAGES}).`,
      });
    }

    const sum =
      env.MAPPING_WEIGHT_LABEL +
      env.MAPPING_WEIGHT_SEMANTIC +
      env.MAPPING_WEIGHT_POSITION +
      env.MAPPING_WEIGHT_STRUCTURE;

    // A drifting sum would silently rescale every candidate score, so it is
    // caught at startup rather than showing up as unexplained confidence.
    if (Math.abs(sum - 1) > 1e-6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAPPING_WEIGHT_LABEL'],
        message: `Candidate weights must sum to 1; they currently sum to ${sum.toFixed(4)}.`,
      });
    }

    const gradingSum =
      env.GRADING_WEIGHT_RUBRIC +
      env.GRADING_WEIGHT_TRANSCRIPTION +
      env.GRADING_WEIGHT_MODEL +
      env.GRADING_WEIGHT_CRITERION;

    if (Math.abs(gradingSum - 1) > 1e-6) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['GRADING_WEIGHT_RUBRIC'],
        message: `Grading confidence weights must sum to 1; they currently sum to ${gradingSum.toFixed(4)}.`,
      });
    }

    if (env.MAPPING_CONFIDENCE_MEDIUM >= env.MAPPING_CONFIDENCE_HIGH) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['MAPPING_CONFIDENCE_MEDIUM'],
        message: 'MAPPING_CONFIDENCE_MEDIUM must be below MAPPING_CONFIDENCE_HIGH.',
      });
    }
  });

export type Env = z.infer<typeof EnvSchema>;

let cached: Env | null = null;

export function getEnv(): Env {
  if (cached) return cached;

  const parsed = EnvSchema.safeParse(process.env);

  if (!parsed.success) {
    const detail = parsed.error.issues
      .map((issue) => `${issue.path.join('.') || '(root)'}: ${issue.message}`)
      .join('; ');
    throw new Error(`Invalid environment configuration — ${detail}`);
  }

  cached = parsed.data;
  return cached;
}

/** Test-only escape hatch so a suite can swap the environment between cases. */
export function resetEnvCache(): void {
  cached = null;
}
