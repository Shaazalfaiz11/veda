import type { Logger } from 'pino';
import { getEnv } from '@/lib/config';
import { ConflictError, ValidationError, isAppError } from '@/lib/errors';
import type {
  Question,
  QuestionExtractionMetadata,
} from '@/lib/domain/question';
import type { AssessmentDocument } from '@/lib/domain/document';
import {
  QUESTION_EXTRACTION_PROMPT_VERSION,
  type AIProvider,
  type ExtractedQuestionCandidate,
  type PageImage,
} from '@/lib/providers/ai';
import { getDocumentStorage } from '@/lib/storage';
import { getAssessmentStore } from '@/lib/services/assessment-store';
import { validateQuestionCandidates } from './question-validation';
// Page-range planning is generic arithmetic over page numbers, so the module
// the answer stage introduced is reused rather than duplicated here.
import {
  planChunks,
  toAbsolutePageNumber,
  type PageChunk,
} from '@/lib/services/answer/answer-chunking';
import { mergeChunkQuestions, type ChunkQuestion } from './question-merge';

/**
 * Question extraction.
 *
 * Owns the whole path from "an assessment has a prepared question paper" to
 * "the assessment holds validated, ordered question objects". It knows
 * nothing about Gemini: it is handed an AIProvider and calls one method on
 * it, which is what lets every case below be tested without a model.
 *
 * The service refuses to call the model unless preparation genuinely
 * finished. Sending a half-prepared document would spend quota to produce
 * coordinates measured against pages that do not exist.
 */

export interface QuestionExtractionContext {
  assessmentId: string;
  jobId: string;
  logger: Logger;
  provider: AIProvider;
}

export interface QuestionExtractionOutcome {
  questions: Question[];
  metadata: QuestionExtractionMetadata;
  reused: boolean;
}

function now(): string {
  return new Date().toISOString();
}

export async function extractQuestions(
  context: QuestionExtractionContext,
): Promise<QuestionExtractionOutcome> {
  const { assessmentId, provider } = context;
  const store = getAssessmentStore();
  const assessment = await store.get(assessmentId);

  const document = assessment.documents.find((entry) => entry.type === 'QUESTION_PAPER');

  if (!document) {
    // Permanent: no retry will produce a document that was never uploaded.
    throw new ValidationError(
      'The assessment has no question paper. Upload one before extracting questions.',
    );
  }

  assertPrepared(document);

  const log = context.logger.child({
    documentId: document.id,
    provider: provider.name,
    model: provider.model,
  });

  // Within-run reuse. The stage record already stops a completed stage from
  // re-running; this covers a re-entry that happens before the stage was
  // recorded, and guarantees a retry can never call the model twice for work
  // that already landed.
  if (assessment.questions.length > 0 && assessment.questionExtraction !== null) {
    log.info(
      { status: 'REUSED', questionCount: assessment.questions.length },
      'assessment.questions.extraction.reused',
    );

    return {
      questions: assessment.questions,
      metadata: assessment.questionExtraction,
      reused: true,
    };
  }

  const pageNumbers = orderedPageNumbers(document);
  const loadImages = makePageImageLoader(document);
  const env = getEnv();

  /*
   * A question paper is read in chunks for the same reason an answer sheet
   * is: a vision provider caps how many images one request may carry, and a
   * long paper exceeds it. The overlap matters slightly less here — a
   * question rarely runs across a page break the way an answer does — but it
   * is kept, because the ones that do are exactly the long multi-part
   * questions worth the most marks.
   *
   * A paper that already fits one chunk takes a single call, as before.
   */
  const chunks = planChunks(pageNumbers, {
    chunkPages: env.QUESTION_CHUNK_PAGES,
    overlap: env.QUESTION_CHUNK_OVERLAP,
  });

  log.info(
    {
      status: 'STARTED',
      pageCount: pageNumbers.length,
      chunkCount: chunks.length,
      chunkPages: env.QUESTION_CHUNK_PAGES,
      chunkOverlap: env.QUESTION_CHUNK_OVERLAP,
    },
    'assessment.questions.extraction.started',
  );

  const started = Date.now();
  const entries: ChunkQuestion[] = [];
  let rawCandidateCount = 0;
  let promptTokens = 0;
  let responseTokens = 0;
  let sawUsage = false;

  for (const chunk of chunks) {
    if (chunk.index > 0 && env.QUESTION_CHUNK_DELAY_MS > 0) {
      await delay(env.QUESTION_CHUNK_DELAY_MS);
    }

    // Loaded per chunk rather than per document, so the previous chunk's
    // base64 is collectable rather than resident for the whole run.
    const images = await loadImages(chunk.pageNumbers);

    let chunkResult: Awaited<ReturnType<AIProvider['extractQuestions']>> | null = null;
    let lastError: unknown = null;

    /*
     * A token-per-minute limit is a rolling window, so a refusal often clears
     * in under a second and the provider says exactly how long to wait. One
     * retry that honours that hint is the difference between a paced run
     * completing and it dying on a margin of a few dozen tokens.
     */
    for (let attempt = 1; attempt <= env.QUESTION_CHUNK_MAX_ATTEMPTS; attempt += 1) {
      try {
        chunkResult = await provider.extractQuestions(images);
        lastError = null;
        break;
      } catch (error) {
        lastError = error;

        const retryable = isAppError(error) ? error.retryable : true;
        if (!retryable || attempt === env.QUESTION_CHUNK_MAX_ATTEMPTS) break;

        const hinted = isAppError(error)
          ? (error.details as { retryAfterMs?: number } | undefined)?.retryAfterMs
          : undefined;

        log.warn(
          {
            status: 'RETRYING',
            chunkIndex: chunk.index,
            attempt,
            waitMs: hinted ?? questionBackoffMs(attempt, env.QUESTION_CHUNK_BACKOFF_MS),
            code: isAppError(error) ? error.code : 'UNKNOWN',
          },
          'assessment.questions.chunk.retrying',
        );

        // A hint below the floor is trusted but padded: the window has to
        // actually clear, and coming back a moment too early wastes the retry.
        await delay(Math.max(hinted ?? 0, questionBackoffMs(attempt, env.QUESTION_CHUNK_BACKOFF_MS)));
      }
    }

    if (!chunkResult) {
      const error = lastError;
      log.error(
        {
          status: 'FAILED',
          pageCount: pageNumbers.length,
          chunkIndex: chunk.index,
          chunkPages: `${chunk.pageNumbers[0]}-${chunk.pageNumbers[chunk.pageNumbers.length - 1]}`,
          code: isAppError(error) ? error.code : 'UNKNOWN',
          retryable: isAppError(error) ? error.retryable : true,
          // The provider attaches what separates one failure from another —
          // the HTTP status behind an unavailable provider, the finish reason
          // behind unparseable JSON. Without it the code is the only clue, and
          // the code is the part already obvious from the message.
          detail: isAppError(error) ? error.details : undefined,
        },
        'assessment.questions.extraction.failed',
      );

      // A question paper is the spine of everything downstream: a mapping
      // built against half a paper would attach answers to the wrong
      // questions. Unlike answer chunks, a lost chunk here fails the stage.
      throw error;
    }

    if (chunkResult.usage) {
      sawUsage = true;
      promptTokens += chunkResult.usage.promptTokens ?? 0;
      responseTokens += chunkResult.usage.responseTokens ?? 0;
    }

    rawCandidateCount += chunkResult.candidates.length;

    for (const candidate of translateQuestions(chunkResult.candidates, chunk, log)) {
      entries.push({ chunkIndex: chunk.index, chunk, candidate });
    }
  }

  const merged = mergeChunkQuestions(entries);

  const result = {
    candidates: merged.candidates,
    usage: sawUsage
      ? { promptTokens, responseTokens, totalTokens: promptTokens + responseTokens }
      : null,
  };

  log.info(
    {
      status: 'MERGED',
      chunkCount: chunks.length,
      candidatesReceived: rawCandidateCount,
      duplicatesMerged: merged.duplicatesMerged,
      candidates: merged.candidates.length,
    },
    'assessment.questions.chunks.merged',
  );

  const validation = validateQuestionCandidates({
    candidates: result.candidates,
    availablePageNumbers: document.pages.map((page) => page.pageNumber),
  });

  const metadata: QuestionExtractionMetadata = {
    provider: provider.name,
    model: provider.model,
    promptVersion: QUESTION_EXTRACTION_PROMPT_VERSION,
    extractedAt: now(),
    pagesProcessed: pageNumbers.length,
    questionsExtracted: validation.questions.length,
    candidatesReceived: result.candidates.length,
    candidatesRejected: validation.rejectedCount,
    warnings: validation.warnings,
    usage: result.usage,
  };

  // Every candidate being rejected means the response was structurally valid
  // but semantically useless. That is a bad extraction, not an empty paper,
  // and persisting nothing while reporting success would hide it.
  if (result.candidates.length > 0 && validation.questions.length === 0) {
    log.error(
      {
        status: 'FAILED',
        candidatesReceived: result.candidates.length,
        candidatesRejected: validation.rejectedCount,
      },
      'assessment.questions.extraction.all_rejected',
    );

    throw new ValidationError(
      `All ${result.candidates.length} extracted questions failed validation.`,
      { warnings: validation.warnings.slice(0, 10) },
    );
  }

  await persist(assessmentId, validation.questions, metadata);

  log.info(
    {
      status: 'COMPLETED',
      pageCount: pageNumbers.length,
      questionCount: validation.questions.length,
      candidatesReceived: result.candidates.length,
      candidatesRejected: validation.rejectedCount,
      warningCount: validation.warnings.length,
      durationMs: Date.now() - started,
      promptVersion: QUESTION_EXTRACTION_PROMPT_VERSION,
      promptTokens: result.usage?.promptTokens ?? null,
      responseTokens: result.usage?.responseTokens ?? null,
    },
    'assessment.questions.extraction.completed',
  );

  for (const warning of validation.warnings) {
    log.warn(
      { code: warning.code, labelRaw: warning.labelRaw, status: 'WARNING' },
      'assessment.questions.extraction.warning',
    );
  }

  return { questions: validation.questions, metadata, reused: false };
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** Quadruples per attempt — long enough for a rolling token window to clear. */
function questionBackoffMs(attempt: number, baseMs: number): number {
  return Math.min(baseMs * 4 ** (attempt - 1), 30_000);
}

/**
 * Rewrites chunk-local page numbers as absolute ones.
 *
 * The prompt tells the model the first image it was given is page 1, so a
 * chunk covering pages 4-6 answers in pages 1-3. Left untranslated, every
 * question past the first chunk would be recorded on the wrong page.
 *
 * A candidate citing a page its chunk never held is dropped rather than
 * mapped onto whatever sits at that index — a fabricated page number must not
 * become a plausible one.
 */
function translateQuestions(
  candidates: readonly ExtractedQuestionCandidate[],
  chunk: PageChunk,
  log: Logger,
): ExtractedQuestionCandidate[] {
  const translated: ExtractedQuestionCandidate[] = [];

  for (const candidate of candidates) {
    const pageNumber = toAbsolutePageNumber(chunk, candidate.pageNumber);

    if (pageNumber === null) {
      log.warn(
        { status: 'WARNING', localPage: candidate.pageNumber, chunkSize: chunk.pageNumbers.length },
        'assessment.questions.chunk.page_out_of_chunk',
      );
      continue;
    }

    const rects = candidate.rects.map((rect) => ({
      ...rect,
      absolute: toAbsolutePageNumber(chunk, rect.pageNumber),
    }));

    if (rects.some((rect) => rect.absolute === null)) {
      log.warn(
        { status: 'WARNING', localPages: rects.map((r) => r.pageNumber) },
        'assessment.questions.chunk.page_out_of_chunk',
      );
      continue;
    }

    translated.push({
      ...candidate,
      pageNumber,
      rects: rects.map(({ absolute, ...rect }) => ({ ...rect, pageNumber: absolute! })),
    });
  }

  return translated;
}

/** Preparation must have genuinely finished before any model call. */
function assertPrepared(document: AssessmentDocument): void {
  if (document.status !== 'READY') {
    throw new ConflictError(
      `The question paper is ${document.status} and cannot be extracted until it is READY.`,
      { documentId: document.id, status: document.status },
    );
  }

  if (document.pages.length === 0 || document.pageCount === null) {
    throw new ConflictError('The question paper has no prepared pages.', {
      documentId: document.id,
    });
  }
}

/** The document's prepared pages, in reading order. No bitmaps are read. */
function orderedPageNumbers(document: AssessmentDocument): number[] {
  return [...document.pages]
    .sort((a, b) => a.pageNumber - b.pageNumber)
    .map((page) => page.pageNumber);
}

type PageImageLoader = (pageNumbers: readonly number[]) => Promise<PageImage[]>;

/**
 * Reads canonical page bitmaps on demand.
 *
 * These are exactly the bitmaps Phase 2 wrote — the same pixels the teacher
 * will see and that normalized coordinates are measured against. Base64 is
 * built here, at the provider boundary, and never enters a log line, an API
 * response or Redis.
 *
 * One chunk's worth at a time. Reading the whole paper up front held every
 * page's base64 for the entire run, to serve one chunk at a time; asking for
 * only the pages a chunk covers lets the rest stay on disk where they are.
 */
function makePageImageLoader(document: AssessmentDocument): PageImageLoader {
  const byPageNumber = new Map(document.pages.map((page) => [page.pageNumber, page]));

  return async (pageNumbers) => {
    const storage = getDocumentStorage();
    const images: PageImage[] = [];

    // Sequential: loading a chunk's pages in parallel would hold each one's
    // buffer and its base64 at the same time for no wall-clock gain.
    for (const pageNumber of pageNumbers) {
      const page = byPageNumber.get(pageNumber);
      if (!page) continue;

      const data = await storage.get(page.storageKey);

      images.push({
        pageNumber: page.pageNumber,
        data: data.toString('base64'),
        mimeType: page.mimeType,
        width: page.width,
        height: page.height,
      });
    }

    return images;
  };
}

async function persist(
  assessmentId: string,
  questions: Question[],
  metadata: QuestionExtractionMetadata,
): Promise<void> {
  await getAssessmentStore().update(assessmentId, (current) => ({
    ...current,
    questions,
    questionExtraction: metadata,
    updatedAt: now(),
  }));
}
