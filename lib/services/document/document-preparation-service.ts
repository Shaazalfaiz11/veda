import type { Logger } from 'pino';
import sharp from 'sharp';
import { getEnv } from '@/lib/config';
import {
  DocumentProcessingFailedError,
  InvalidDocumentError,
  ValidationError,
  isAppError,
} from '@/lib/errors';
import type { AssessmentDocument, PreparedPage } from '@/lib/domain/document';
import { FORMAT_TO_MIME } from '@/lib/domain/document';
import { getDocumentStorage, preparedPageKey } from '@/lib/storage';
import {
  getDocument,
  listDocuments,
  readOriginal,
  recordDocumentFailure,
  recordDocumentPages,
  setDocumentStatus,
} from './document-service';
import { openPdf, type RenderedPage } from './pdf-preparation';
import { prepareImage } from './image-preparation';

/**
 * Document preparation.
 *
 * Turns every uploaded document into an ordered list of PreparedPage records
 * plus one PNG bitmap per page in storage. That bitmap is the canonical page:
 * the same pixels are later sent to the vision model, served to the frontend,
 * and used as the reference frame for normalized answer-region coordinates.
 * Nothing downstream renders its own.
 *
 * Idempotency has two layers. Phase 1's stage record stops the PREPARING
 * stage re-running once it has completed. Within a single run, a document
 * already READY is reused wholesale, and a partially prepared document is
 * reconciled page by page against storage — so a retry after a mid-document
 * failure resumes rather than re-rasterising work that already landed.
 */

export interface PreparationContext {
  assessmentId: string;
  jobId: string;
  logger: Logger;
}

export interface DocumentPreparationResult {
  documentId: string;
  type: AssessmentDocument['type'];
  pageCount: number;
  renderedPages: number;
  reusedPages: number;
  reusedDocument: boolean;
}

export interface PreparationSummary {
  documents: DocumentPreparationResult[];
  totalPages: number;
}

export async function prepareAssessmentDocuments(
  context: PreparationContext,
): Promise<PreparationSummary> {
  const documents = await listDocuments(context.assessmentId);

  if (documents.length === 0) {
    // Permanent: retrying cannot conjure an upload.
    throw new ValidationError(
      'The assessment has no documents to prepare. Upload a document before processing.',
    );
  }

  const missingTypes = (['QUESTION_PAPER', 'ANSWER_SHEET'] as const).filter(
    (type) => !documents.some((document) => document.type === type),
  );

  if (missingTypes.length > 0) {
    context.logger.warn(
      { missingTypes, status: 'INCOMPLETE' },
      'assessment.documents.incomplete',
    );
  }

  const results: DocumentPreparationResult[] = [];

  for (const document of documents) {
    results.push(await prepareDocument(document.id, context));
  }

  return {
    documents: results,
    totalPages: results.reduce((total, result) => total + result.pageCount, 0),
  };
}

async function prepareDocument(
  documentId: string,
  context: PreparationContext,
): Promise<DocumentPreparationResult> {
  // Re-read rather than trusting the caller's snapshot: an earlier document
  // in this run has already mutated the assessment record.
  const document = await getDocument(context.assessmentId, documentId);

  const log = context.logger.child({
    documentId,
    documentType: document.type,
    format: document.format,
  });

  const reusable = await findReusableDocument(document);

  if (reusable) {
    log.info(
      { pageCount: reusable.length, status: 'REUSED' },
      'assessment.document.preparation.reused',
    );

    return {
      documentId,
      type: document.type,
      pageCount: reusable.length,
      renderedPages: 0,
      reusedPages: reusable.length,
      reusedDocument: true,
    };
  }

  if (document.status !== 'PREPARING') {
    await setDocumentStatus(context.assessmentId, documentId, 'PREPARING');
  }

  log.info({ status: 'STARTED' }, 'assessment.document.preparation.started');

  try {
    const pages =
      document.format === 'PDF'
        ? await preparePdfDocument(document, log)
        : await prepareImageDocument(document, log);

    await recordDocumentPages(context.assessmentId, documentId, pages.pages);

    log.info(
      {
        status: 'READY',
        pageCount: pages.pages.length,
        renderedPages: pages.rendered,
        reusedPages: pages.reused,
      },
      'assessment.document.preparation.completed',
    );

    return {
      documentId,
      type: document.type,
      pageCount: pages.pages.length,
      renderedPages: pages.rendered,
      reusedPages: pages.reused,
      reusedDocument: false,
    };
  } catch (error) {
    const code = isAppError(error) ? error.code : 'DOCUMENT_PROCESSING_FAILED';
    const message =
      error instanceof Error ? error.message : 'The document could not be prepared.';

    await recordDocumentFailure(context.assessmentId, documentId, { code, message });

    log.error({ status: 'FAILED', code }, 'assessment.document.preparation.failed');

    // A malformed file is permanent; anything else may be transient, so it is
    // re-thrown as retryable and the queue's backoff gets a chance.
    if (isAppError(error) && !error.retryable) throw error;

    throw new DocumentProcessingFailedError(message, { documentId, code });
  }
}

/**
 * Returns the existing prepared pages when a document is already complete and
 * every bitmap is still intact in storage.
 *
 * Intact means present *and* the recorded size, which is a stat call rather
 * than a decode. A blob that was deleted or left truncated by an interrupted
 * write fails this check, and the document is re-prepared page by page —
 * a record that claims READY is not on its own evidence that it is.
 */
async function findReusableDocument(
  document: AssessmentDocument,
): Promise<PreparedPage[] | null> {
  if (document.status !== 'READY') return null;
  if (document.pageCount === null || document.pages.length !== document.pageCount) return null;

  const storage = getDocumentStorage();

  for (const page of document.pages) {
    const head = await storage.head(page.storageKey);
    if (!head || head.sizeBytes !== page.sizeBytes) return null;
  }

  return document.pages;
}

interface PreparedPages {
  pages: PreparedPage[];
  rendered: number;
  reused: number;
}

async function preparePdfDocument(
  document: AssessmentDocument,
  log: Logger,
): Promise<PreparedPages> {
  const { PREPARED_PAGE_MAX_DIMENSION, MAX_DOCUMENT_PAGES } = getEnv();

  const original = await readOriginal(document);
  const pdf = await openPdf(original);

  try {
    if (pdf.pageCount > MAX_DOCUMENT_PAGES) {
      throw new InvalidDocumentError(
        `The document has ${pdf.pageCount} pages, exceeding the limit of ${MAX_DOCUMENT_PAGES}.`,
        { pageCount: pdf.pageCount, maxPages: MAX_DOCUMENT_PAGES },
      );
    }

    const pages: PreparedPage[] = [];
    let rendered = 0;
    let reused = 0;

    // Sequential by design: rasterising many pages in parallel multiplies
    // peak memory by the concurrency for no wall-clock gain on one core.
    for (let pageNumber = 1; pageNumber <= pdf.pageCount; pageNumber += 1) {
      const key = preparedPageKey(document.assessmentId, document.id, pageNumber);

      const existing = await reuseStoredPage(document, pageNumber, key);

      if (existing) {
        pages.push(existing);
        reused += 1;
        continue;
      }

      const page = await pdf.renderPage(pageNumber, PREPARED_PAGE_MAX_DIMENSION);
      pages.push(await storePage(document, page, key));
      rendered += 1;
    }

    log.debug({ rendered, reused }, 'assessment.document.pages.prepared');

    return { pages, rendered, reused };
  } finally {
    await pdf.close();
  }
}

async function prepareImageDocument(
  document: AssessmentDocument,
  log: Logger,
): Promise<PreparedPages> {
  const { PREPARED_PAGE_MAX_DIMENSION } = getEnv();

  const key = preparedPageKey(document.assessmentId, document.id, 1);
  const existing = await reuseStoredPage(document, 1, key);

  if (existing) {
    log.debug({ rendered: 0, reused: 1 }, 'assessment.document.pages.prepared');
    return { pages: [existing], rendered: 0, reused: 1 };
  }

  const original = await readOriginal(document);
  const page = await prepareImage(original, PREPARED_PAGE_MAX_DIMENSION);

  log.debug({ rendered: 1, reused: 0 }, 'assessment.document.pages.prepared');

  return { pages: [await storePage(document, page, key)], rendered: 1, reused: 0 };
}

/**
 * Reconciles one page against storage.
 *
 * A bitmap left behind by an interrupted run is reused only when its actual
 * dimensions can be read back and matched to a page record. Verifying rather
 * than assuming means a truncated write is re-rendered instead of silently
 * becoming the canonical page.
 */
async function reuseStoredPage(
  document: AssessmentDocument,
  pageNumber: number,
  key: string,
): Promise<PreparedPage | null> {
  const record = document.pages.find((page) => page.pageNumber === pageNumber);
  if (!record) return null;

  const storage = getDocumentStorage();
  const head = await storage.head(key);
  if (!head || head.sizeBytes === 0) return null;

  try {
    const metadata = await sharp(await storage.get(key)).metadata();

    if (metadata.width !== record.width || metadata.height !== record.height) {
      return null;
    }
  } catch {
    return null;
  }

  return { ...record, storageKey: key, sizeBytes: head.sizeBytes };
}

async function storePage(
  document: AssessmentDocument,
  page: RenderedPage,
  key: string,
): Promise<PreparedPage> {
  const stored = await getDocumentStorage().put(key, page.data, {
    contentType: FORMAT_TO_MIME.PNG,
  });

  return {
    documentId: document.id,
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    aspectRatio: Number((page.width / page.height).toFixed(6)),
    sourceWidth: Number(page.sourceWidth.toFixed(4)),
    sourceHeight: Number(page.sourceHeight.toFixed(4)),
    scale: Number(page.scale.toFixed(6)),
    rotation: page.rotation,
    storageKey: key,
    mimeType: FORMAT_TO_MIME.PNG,
    sizeBytes: stored.sizeBytes,
  };
}
