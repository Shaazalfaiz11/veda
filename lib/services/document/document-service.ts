import { randomUUID } from 'node:crypto';
import type { Readable } from 'node:stream';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import {
  assertDocumentTransition,
  toDocumentMetadata,
  type AssessmentDocument,
  type DocumentFailure,
  type DocumentMetadata,
  type DocumentStatus,
  type DocumentType,
  type PreparedPage,
} from '@/lib/domain/document';
import { findDocument } from '@/lib/domain/assessment';
import { getAssessmentStore } from '@/lib/services/assessment-store';
import {
  getDocumentStorage,
  documentPrefix,
  originalDocumentKey,
  sanitizeFilename,
} from '@/lib/storage';
import { validateUpload, SNIFF_LENGTH } from './file-validation';

/**
 * Document service.
 *
 * Documents live inside the assessment record, so every mutation goes
 * through the Phase 1 store's optimistic update — two concurrent uploads
 * cannot lose each other's writes.
 */

export interface UploadDocumentInput {
  assessmentId: string;
  type: DocumentType;
  filename: string | null;
  declaredMimeType: string | null;
  /** Full file bytes. Callers must enforce the size ceiling while reading. */
  data: Buffer;
}

function now(): string {
  return new Date().toISOString();
}

/**
 * Accepts an uploaded file.
 *
 * The assessment must exist and must not be mid-run: replacing a document
 * underneath a worker that is already preparing it would leave the prepared
 * pages describing a file that no longer exists.
 */
export async function uploadDocument(input: UploadDocumentInput): Promise<DocumentMetadata> {
  const store = getAssessmentStore();
  const assessment = await store.get(input.assessmentId);

  if (assessment.status === 'QUEUED' || assessment.status === 'PROCESSING') {
    throw new ConflictError(
      `Documents cannot be changed while the assessment is ${assessment.status.toLowerCase()}.`,
      { status: assessment.status },
    );
  }

  const validated = validateUpload({
    head: input.data.subarray(0, SNIFF_LENGTH),
    sizeBytes: input.data.byteLength,
    declaredMimeType: input.declaredMimeType,
    filename: input.filename,
  });

  const documentId = randomUUID();
  const storageKey = originalDocumentKey(input.assessmentId, documentId);
  const storage = getDocumentStorage();

  await storage.put(storageKey, input.data, { contentType: validated.mimeType });

  const document: AssessmentDocument = {
    id: documentId,
    assessmentId: input.assessmentId,
    type: input.type,
    status: 'UPLOADED',
    originalFilename: sanitizeFilename(input.filename ?? '', `${input.type.toLowerCase()}`),
    format: validated.format,
    mimeType: validated.mimeType,
    sizeBytes: validated.sizeBytes,
    pageCount: null,
    pages: [],
    storageKey,
    failure: null,
    uploadedAt: now(),
    preparedAt: null,
  };

  // One document per type: a second question paper replaces the first rather
  // than leaving the pipeline to guess which one is authoritative.
  const replaced = assessment.documents.find((existing) => existing.type === input.type);

  await store.update(input.assessmentId, (current) => ({
    ...current,
    documents: [
      ...current.documents.filter((existing) => existing.type !== input.type),
      document,
    ],
    updatedAt: now(),
  }));

  if (replaced) {
    // Best effort: a stale blob is harmless, a failed upload is not.
    await storage
      .deletePrefix(documentPrefix(input.assessmentId, replaced.id))
      .catch(() => undefined);
  }

  logger.info(
    {
      assessmentId: input.assessmentId,
      documentId,
      type: input.type,
      format: validated.format,
      sizeBytes: validated.sizeBytes,
      claimMismatch: validated.claimMismatch,
      replacedDocumentId: replaced?.id ?? null,
      status: 'UPLOADED',
    },
    'assessment.document.uploaded',
  );

  return toDocumentMetadata(document);
}

export async function listDocuments(assessmentId: string): Promise<AssessmentDocument[]> {
  const assessment = await getAssessmentStore().get(assessmentId);
  return assessment.documents;
}

export async function getDocument(
  assessmentId: string,
  documentId: string,
): Promise<AssessmentDocument> {
  const assessment = await getAssessmentStore().get(assessmentId);
  const document = findDocument(assessment, documentId);

  if (!document) {
    throw new NotFoundError(`Document ${documentId} was not found on this assessment.`);
  }

  return document;
}

/** Applies a mutation to one document inside the assessment record. */
async function updateDocument(
  assessmentId: string,
  documentId: string,
  mutate: (document: AssessmentDocument) => AssessmentDocument,
): Promise<AssessmentDocument> {
  let updated: AssessmentDocument | null = null;

  await getAssessmentStore().update(assessmentId, (current) => {
    const existing = current.documents.find((document) => document.id === documentId);

    if (!existing) {
      throw new NotFoundError(`Document ${documentId} was not found on this assessment.`);
    }

    updated = mutate(existing);
    const next = updated;

    return {
      ...current,
      documents: current.documents.map((document) =>
        document.id === documentId ? next : document,
      ),
      updatedAt: now(),
    };
  });

  if (!updated) {
    throw new NotFoundError(`Document ${documentId} was not found on this assessment.`);
  }

  return updated;
}

export async function setDocumentStatus(
  assessmentId: string,
  documentId: string,
  status: DocumentStatus,
): Promise<AssessmentDocument> {
  return updateDocument(assessmentId, documentId, (document) => {
    if (document.status === status) return document;
    assertDocumentTransition(document.status, status);
    return { ...document, status, failure: status === 'FAILED' ? document.failure : null };
  });
}

export async function recordDocumentPages(
  assessmentId: string,
  documentId: string,
  pages: PreparedPage[],
): Promise<AssessmentDocument> {
  if (pages.length === 0) {
    throw new ValidationError('A prepared document must have at least one page.');
  }

  return updateDocument(assessmentId, documentId, (document) => ({
    ...document,
    status: 'READY',
    pageCount: pages.length,
    // Stored in page order regardless of the order preparation produced them.
    pages: [...pages].sort((a, b) => a.pageNumber - b.pageNumber),
    failure: null,
    preparedAt: now(),
  }));
}

export async function recordDocumentFailure(
  assessmentId: string,
  documentId: string,
  failure: Omit<DocumentFailure, 'failedAt'>,
): Promise<AssessmentDocument> {
  return updateDocument(assessmentId, documentId, (document) => ({
    ...document,
    status: 'FAILED',
    failure: { ...failure, failedAt: now() },
  }));
}

/** Reads the original uploaded bytes back out of storage. */
export async function readOriginal(document: AssessmentDocument): Promise<Buffer> {
  return getDocumentStorage().get(document.storageKey);
}

/** Streams a prepared page bitmap. Used by the page-serving route. */
export async function readPreparedPageStream(
  document: AssessmentDocument,
  pageNumber: number,
): Promise<{ stream: Readable; page: PreparedPage }> {
  const page = document.pages.find((candidate) => candidate.pageNumber === pageNumber);

  if (!page) {
    throw new NotFoundError(
      `Page ${pageNumber} is not available for document ${document.id}.`,
    );
  }

  const stream = await getDocumentStorage().getStream(page.storageKey);
  return { stream, page };
}
