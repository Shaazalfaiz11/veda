import type { Logger } from 'pino';
import { getEnv } from '@/lib/config';
import { ConflictError, ValidationError, isAppError } from '@/lib/errors';
import type {
  Answer,
  AnswerExtractionMetadata,
  AnswerExtractionWarning,
  FailedChunk,
} from '@/lib/domain/answer';
import type { AssessmentDocument } from '@/lib/domain/document';
import {
  ANSWER_EXTRACTION_PROMPT_VERSION,
  type AIProvider,
  type ExtractedAnswerCandidate,
  type PageImage,
  type ProviderUsage,
} from '@/lib/providers/ai';
import { getDocumentStorage } from '@/lib/storage';
import { getAssessmentStore } from '@/lib/services/assessment-store';
import { validateAnswerCandidates } from './answer-validation';
import { planChunks, toAbsolutePageNumber, type PageChunk } from './answer-chunking';
import { mergeChunkCandidates, type ChunkCandidate } from './answer-merge';

/**
 * Answer extraction.
 *
 * Owns the path from "an assessment has a prepared answer sheet" to "the
 * assessment holds validated, ordered answer blocks". It knows nothing about
 * Gemini: it is handed an AIProvider and calls one method on it.
 *
 * A long sheet is read as **overlapping page chunks** rather than in one
 * request. One request over twenty pages asks for a reply containing every
 * answer on every page, and past a dozen or so the model stops returning it
 * intact. Chunking bounds each reply; the overlap is what stops the split
 * from breaking answers that run across a page boundary. See
 * `answer-chunking.ts` for exactly what that guarantees.
 *
 * A sheet short enough to fit one chunk takes a single call, exactly as
 * before.
 *
 * It performs no mapping. Nothing here reads the question list, and nothing
 * here writes a question reference onto an answer — the two are kept apart so
 * that a transcription artefact can never quietly become a mapping decision.
 */

export interface AnswerExtractionContext {
  assessmentId: string;
  jobId: string;
  logger: Logger;
  provider: AIProvider;
}

export interface AnswerExtractionOutcome {
  answers: Answer[];
  metadata: AnswerExtractionMetadata;
  reused: boolean;
}

function now(): string {
  return new Date().toISOString();
}

function delay(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

/** 2s, then 8s, then 32s — long enough to outlast a short overload window. */
function chunkBackoffMs(attempt: number): number {
  return Math.min(2_000 * 4 ** (attempt - 1), 32_000);
}

export async function extractAnswers(
  context: AnswerExtractionContext,
): Promise<AnswerExtractionOutcome> {
  const { assessmentId, provider } = context;
  const env = getEnv();
  const store = getAssessmentStore();
  const assessment = await store.get(assessmentId);

  const document = assessment.documents.find((entry) => entry.type === 'ANSWER_SHEET');

  if (!document) {
    // Permanent: no retry will produce a sheet that was never uploaded.
    throw new ValidationError(
      'The assessment has no answer sheet. Upload one before extracting answers.',
    );
  }

  assertPrepared(document);

  const log = context.logger.child({
    documentId: document.id,
    provider: provider.name,
    model: provider.model,
  });

  // Within-run reuse, on top of the stage record. Guarantees a retry can
  // never call the model twice for work that already landed.
  if (assessment.answers.length > 0 && assessment.answerExtraction !== null) {
    log.info(
      { status: 'REUSED', answerCount: assessment.answers.length },
      'assessment.answers.extraction.reused',
    );

    return {
      answers: assessment.answers,
      metadata: assessment.answerExtraction,
      reused: true,
    };
  }

  const pages = await loadPageImages(document);
  const chunks = planChunks(
    pages.map((page) => page.pageNumber),
    { chunkPages: env.ANSWER_CHUNK_PAGES, overlap: env.ANSWER_CHUNK_OVERLAP },
  );

  log.info(
    {
      status: 'STARTED',
      pageCount: pages.length,
      chunkCount: chunks.length,
      chunkPages: env.ANSWER_CHUNK_PAGES,
      chunkOverlap: env.ANSWER_CHUNK_OVERLAP,
    },
    'assessment.answers.extraction.started',
  );

  const started = Date.now();
  const run = await readChunks({ chunks, pages, provider, log, env });

  // Nothing at all was read. That is the whole-document failure the queue
  // should retry, so the chunk error is rethrown rather than reported as an
  // empty but successful extraction.
  if (run.succeeded === 0 && run.failures.length > 0) {
    log.error(
      {
        status: 'FAILED',
        pageCount: pages.length,
        chunkCount: chunks.length,
        failedChunks: run.failures.length,
      },
      'assessment.answers.extraction.failed',
    );

    throw run.firstError;
  }

  const merged = mergeChunkCandidates(run.entries);

  const validation = validateAnswerCandidates({
    candidates: merged.candidates,
    availablePageNumbers: document.pages.map((page) => page.pageNumber),
  });

  const warnings: AnswerExtractionWarning[] = [
    ...run.failures.map(
      (failure): AnswerExtractionWarning => ({
        code: 'CHUNK_FAILED',
        message:
          `Pages ${describeRange(failure.pageNumbers)} could not be read (${failure.code}): ` +
          `${failure.message} Any answers on those pages are missing.`,
        claimedLabelRaw: null,
      }),
    ),
    ...validation.warnings,
  ];

  const metadata: AnswerExtractionMetadata = {
    provider: provider.name,
    model: provider.model,
    promptVersion: ANSWER_EXTRACTION_PROMPT_VERSION,
    extractedAt: now(),
    pagesProcessed: pages.length,
    answersExtracted: validation.answers.length,
    candidatesReceived: run.rawCandidateCount,
    candidatesRejected: validation.rejectedCount,
    unlabelledCount: validation.answers.filter((answer) => answer.claimedLabelRaw === null)
      .length,
    warnings,
    usage: run.usage,
    chunkCount: chunks.length,
    failedChunks: run.failures,
    partial: run.failures.length > 0,
    duplicatesMerged: merged.duplicatesMerged,
  };

  // Every candidate rejected means the response was structurally valid but
  // semantically useless — a bad extraction, not a blank sheet. Persisting
  // nothing while reporting success would hide it.
  if (merged.candidates.length > 0 && validation.answers.length === 0) {
    log.error(
      {
        status: 'FAILED',
        candidatesReceived: merged.candidates.length,
        candidatesRejected: validation.rejectedCount,
        // Without the reasons this line says only that everything was thrown
        // away, which is the one thing already obvious from the count. The
        // codes and messages are the diagnosis; they describe the shape of
        // the candidate, never the student's writing.
        reasons: validation.warnings
          .filter((warning) => warning.code === 'REJECTED_CANDIDATE')
          .slice(0, 10)
          .map((warning) => warning.message),
      },
      'assessment.answers.extraction.all_rejected',
    );

    throw new ValidationError(
      `All ${merged.candidates.length} extracted answers failed validation.`,
      { warnings: validation.warnings.slice(0, 10) },
    );
  }

  await persist(assessmentId, validation.answers, metadata);

  log.info(
    {
      status: metadata.partial ? 'PARTIAL' : 'COMPLETED',
      pageCount: pages.length,
      chunkCount: chunks.length,
      failedChunks: run.failures.length,
      answerCount: validation.answers.length,
      duplicatesMerged: merged.duplicatesMerged,
      unlabelledCount: metadata.unlabelledCount,
      multiPageCount: validation.answers.filter((answer) => answer.spansPages).length,
      diagramCount: validation.answers.filter((answer) => answer.containsDiagram).length,
      candidatesReceived: run.rawCandidateCount,
      candidatesRejected: validation.rejectedCount,
      warningCount: warnings.length,
      durationMs: Date.now() - started,
      promptVersion: ANSWER_EXTRACTION_PROMPT_VERSION,
      promptTokens: run.usage?.promptTokens ?? null,
      responseTokens: run.usage?.responseTokens ?? null,
    },
    'assessment.answers.extraction.completed',
  );

  for (const warning of warnings) {
    log.warn(
      { code: warning.code, status: 'WARNING' },
      'assessment.answers.extraction.warning',
    );
  }

  return { answers: validation.answers, metadata, reused: false };
}

interface ChunkRunResult {
  entries: ChunkCandidate[];
  failures: FailedChunk[];
  succeeded: number;
  /**
   * Candidates the model actually returned, summed over chunks. Larger than
   * the merged count whenever the overlap caused an answer to be read twice;
   * `duplicatesMerged` is the difference.
   */
  rawCandidateCount: number;
  usage: ProviderUsage | null;
  /** Rethrown when nothing was read at all, so the queue sees the real cause. */
  firstError: unknown;
}

/**
 * Reads every chunk, in order.
 *
 * Sequential rather than concurrent, and deliberately so: parallel requests
 * against a rate-limited tier turn a slow extraction into a failed one, and
 * this stage has already been observed hitting 429s. The pacing delay exists
 * for the same reason.
 *
 * A chunk that fails after its own retries is recorded and the run continues.
 * Losing the answers on four pages is bad; losing the whole sheet because of
 * them is worse, and the loss is reported rather than absorbed.
 */
async function readChunks(input: {
  chunks: PageChunk[];
  pages: PageImage[];
  provider: AIProvider;
  log: Logger;
  env: ReturnType<typeof getEnv>;
}): Promise<ChunkRunResult> {
  const { chunks, pages, provider, log, env } = input;

  const byPageNumber = new Map(pages.map((page) => [page.pageNumber, page]));
  const entries: ChunkCandidate[] = [];
  const failures: FailedChunk[] = [];

  let succeeded = 0;
  let rawCandidateCount = 0;
  let firstError: unknown = null;
  let promptTokens = 0;
  let responseTokens = 0;
  let sawUsage = false;

  for (const chunk of chunks) {
    if (chunk.index > 0 && env.ANSWER_CHUNK_DELAY_MS > 0) {
      await delay(env.ANSWER_CHUNK_DELAY_MS);
    }

    const images = chunk.pageNumbers
      .map((pageNumber) => byPageNumber.get(pageNumber))
      .filter((page): page is PageImage => page !== undefined);

    const chunkLog = log.child({
      chunkIndex: chunk.index,
      chunkPages: describeRange(chunk.pageNumbers),
    });

    let lastError: unknown = null;
    let done = false;

    for (let attempt = 1; attempt <= env.ANSWER_CHUNK_MAX_ATTEMPTS && !done; attempt += 1) {
      try {
        const result = await provider.extractAnswers(images);

        if (result.usage) {
          sawUsage = true;
          promptTokens += result.usage.promptTokens ?? 0;
          responseTokens += result.usage.responseTokens ?? 0;
        }

        rawCandidateCount += result.candidates.length;
        const translated = translateCandidates(result.candidates, chunk, chunkLog);

        for (const candidate of translated) {
          entries.push({ chunkIndex: chunk.index, chunk, candidate });
        }

        succeeded += 1;
        done = true;

        chunkLog.info(
          {
            status: 'COMPLETED',
            attempt,
            candidateCount: translated.length,
            droppedOutOfRange: result.candidates.length - translated.length,
            responseTokens: result.usage?.responseTokens ?? null,
          },
          'assessment.answers.chunk.completed',
        );
      } catch (error) {
        lastError = error;
        firstError ??= error;

        const retryable = isAppError(error) ? error.retryable : true;

        chunkLog.error(
          {
            status: 'FAILED',
            attempt,
            maxAttempts: env.ANSWER_CHUNK_MAX_ATTEMPTS,
            code: isAppError(error) ? error.code : 'UNKNOWN',
            retryable,
            // What distinguishes one failure from another: the finish reason
            // behind unparseable JSON, the status behind a provider refusal.
            detail: isAppError(error) ? error.details : undefined,
          },
          'assessment.answers.chunk.failed',
        );

        // A permanent failure will fail again identically, so further attempts
        // only spend quota and time.
        if (!retryable) break;

        /*
         * Back off before trying again.
         *
         * Observed against the real API: a 503 ("the model is overloaded")
         * arrives in clusters lasting tens of seconds. Retrying immediately
         * puts the second attempt inside the same bad window, so both fail and
         * the chunk is lost to a condition that would have cleared on its own.
         * Waiting is the entire point of a retry here.
         *
         * A token-per-minute refusal says exactly how long the window has left,
         * and that number is routinely far longer than the local backoff — the
         * first answer chunk lands immediately after the last question chunk,
         * inside a window the question stage has already spent. Ignoring the
         * hint burns both attempts inside the same minute. Question extraction
         * already honours it; this is the same rule.
         */
        if (attempt < env.ANSWER_CHUNK_MAX_ATTEMPTS) {
          const hinted = isAppError(error)
            ? (error.details as { retryAfterMs?: number } | undefined)?.retryAfterMs
            : undefined;

          await delay(Math.max(hinted ?? 0, chunkBackoffMs(attempt)));
        }
      }
    }

    if (!done) {
      failures.push({
        index: chunk.index,
        pageNumbers: chunk.pageNumbers,
        code: isAppError(lastError) ? lastError.code : 'UNKNOWN',
        message: lastError instanceof Error ? lastError.message : String(lastError),
      });
    }
  }

  return {
    entries,
    failures,
    succeeded,
    rawCandidateCount,
    usage: sawUsage
      ? {
          promptTokens,
          responseTokens,
          totalTokens: promptTokens + responseTokens,
        }
      : null,
    firstError,
  };
}

/**
 * Rewrites chunk-local page numbers as absolute ones.
 *
 * The prompt tells the model that the first image it was given is page 1, so
 * a chunk covering pages 7-10 returns regions numbered 1-4. Without this the
 * answers past the first chunk would be recorded on the wrong pages, and the
 * mapping screen would draw their overlays over unrelated handwriting.
 *
 * A candidate citing a page its chunk did not contain is dropped here rather
 * than translated into whatever page happens to sit at that index — a
 * fabricated page number must not be turned into a plausible one.
 */
function translateCandidates(
  candidates: readonly ExtractedAnswerCandidate[],
  chunk: PageChunk,
  log: Logger,
): ExtractedAnswerCandidate[] {
  const translated: ExtractedAnswerCandidate[] = [];

  for (const candidate of candidates) {
    if (!Array.isArray(candidate.regions) || candidate.regions.length === 0) {
      // Keep it: validation owns rejecting shapeless candidates, and doing it
      // here too would split that rule across two modules.
      translated.push(candidate);
      continue;
    }

    const regions = candidate.regions.map((region) => ({
      ...region,
      absolute: toAbsolutePageNumber(chunk, region.pageNumber),
    }));

    const invalid = regions.filter((region) => region.absolute === null);

    if (invalid.length > 0) {
      log.warn(
        {
          status: 'WARNING',
          localPages: invalid.map((region) => region.pageNumber),
          chunkSize: chunk.pageNumbers.length,
        },
        'assessment.answers.chunk.page_out_of_chunk',
      );
      continue;
    }

    translated.push({
      ...candidate,
      regions: regions.map(({ absolute, ...region }) => ({
        ...region,
        pageNumber: absolute!,
      })),
    });
  }

  return translated;
}

/** "7-10", or "7" for a single page. Page numbers only; never content. */
function describeRange(pageNumbers: readonly number[]): string {
  if (pageNumbers.length === 0) return 'none';
  const first = pageNumbers[0]!;
  const last = pageNumbers[pageNumbers.length - 1]!;
  return first === last ? `${first}` : `${first}-${last}`;
}

/** Preparation must have genuinely finished before any model call. */
function assertPrepared(document: AssessmentDocument): void {
  if (document.status !== 'READY') {
    throw new ConflictError(
      `The answer sheet is ${document.status} and cannot be extracted until it is READY.`,
      { documentId: document.id, status: document.status },
    );
  }

  if (document.pages.length === 0 || document.pageCount === null) {
    throw new ConflictError('The answer sheet has no prepared pages.', {
      documentId: document.id,
    });
  }
}

/**
 * Loads canonical page bitmaps — the same pixels Phase 2 wrote, which the
 * teacher will later see and which the stored coordinates are measured
 * against. Base64 is built here, at the provider boundary, and never enters a
 * log line, an API response or Redis.
 */
async function loadPageImages(document: AssessmentDocument): Promise<PageImage[]> {
  const storage = getDocumentStorage();
  const pages = [...document.pages].sort((a, b) => a.pageNumber - b.pageNumber);

  const images: PageImage[] = [];

  // Sequential: a long sheet loaded in parallel would hold every bitmap in
  // memory at once for no wall-clock gain.
  for (const page of pages) {
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
}

async function persist(
  assessmentId: string,
  answers: Answer[],
  metadata: AnswerExtractionMetadata,
): Promise<void> {
  await getAssessmentStore().update(assessmentId, (current) => ({
    ...current,
    answers,
    answerExtraction: metadata,
    updatedAt: now(),
  }));
}
