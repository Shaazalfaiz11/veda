/**
 * Document domain.
 *
 * A Document is one uploaded file belonging to an assessment. Preparation
 * turns it into an ordered list of PreparedPage records — the canonical page
 * representation the rest of the system works from.
 */

/** What role the document plays in the assessment. */
export const DOCUMENT_TYPES = ['QUESTION_PAPER', 'ANSWER_SHEET'] as const;
export type DocumentType = (typeof DOCUMENT_TYPES)[number];

/** Formats the server is willing to prepare. */
export const DOCUMENT_FORMATS = ['PDF', 'PNG', 'JPEG'] as const;
export type DocumentFormat = (typeof DOCUMENT_FORMATS)[number];

/**
 * Document lifecycle. Deliberately separate from AssessmentStatus: an
 * assessment is PROCESSING while its individual documents move UPLOADED ->
 * PREPARING -> READY. Conflating the two loses the ability to say which
 * document failed.
 */
export const DOCUMENT_STATUSES = ['UPLOADED', 'PREPARING', 'READY', 'FAILED'] as const;
export type DocumentStatus = (typeof DOCUMENT_STATUSES)[number];

export function isDocumentType(value: unknown): value is DocumentType {
  return typeof value === 'string' && (DOCUMENT_TYPES as readonly string[]).includes(value);
}

export function isDocumentFormat(value: unknown): value is DocumentFormat {
  return typeof value === 'string' && (DOCUMENT_FORMATS as readonly string[]).includes(value);
}

export function isDocumentStatus(value: unknown): value is DocumentStatus {
  return typeof value === 'string' && (DOCUMENT_STATUSES as readonly string[]).includes(value);
}

/** MIME types accepted on upload, mapped to the format they resolve to. */
export const MIME_TO_FORMAT: Readonly<Record<string, DocumentFormat>> = {
  'application/pdf': 'PDF',
  'image/png': 'PNG',
  'image/jpeg': 'JPEG',
};

/** Extensions accepted on upload. Advisory only — content decides. */
export const EXTENSION_TO_FORMAT: Readonly<Record<string, DocumentFormat>> = {
  '.pdf': 'PDF',
  '.png': 'PNG',
  '.jpg': 'JPEG',
  '.jpeg': 'JPEG',
};

/** The canonical MIME type the server emits for each format it prepares. */
export const FORMAT_TO_MIME: Readonly<Record<DocumentFormat, string>> = {
  PDF: 'application/pdf',
  PNG: 'image/png',
  JPEG: 'image/jpeg',
};

export interface PageDimensions {
  width: number;
  height: number;
}

/**
 * The canonical page representation.
 *
 * `width` and `height` describe the *prepared* bitmap — the exact pixels that
 * are sent to a vision model, shown to the teacher, and that normalized
 * answer-region coordinates are measured against. There is one bitmap per
 * page and it serves all three purposes; nothing downstream may render its
 * own.
 *
 * `sourceWidth`/`sourceHeight` and `scale` record the transformation applied
 * during preparation, so the relationship to the original document stays
 * explicit and reversible.
 */
export interface PreparedPage {
  documentId: string;

  /** 1-based, stable, and in original document order. */
  pageNumber: number;

  /** Prepared bitmap dimensions, in pixels. */
  width: number;
  height: number;

  /** width / height of the prepared bitmap. */
  aspectRatio: number;

  /** Geometry of the source page before preparation, in its own units. */
  sourceWidth: number;
  sourceHeight: number;

  /** Factor applied to source geometry to reach the prepared bitmap. */
  scale: number;

  /** Rotation baked into the prepared bitmap, in degrees. */
  rotation: number;

  /** Opaque storage key for the prepared bitmap. Never a filesystem path. */
  storageKey: string;

  /** MIME type of the prepared bitmap. */
  mimeType: string;

  /** Size of the prepared bitmap, in bytes. */
  sizeBytes: number;
}

export interface DocumentFailure {
  code: string;
  message: string;
  failedAt: string;
}

/**
 * A document belonging to an assessment.
 *
 * `storageKey` is an opaque handle into the storage provider, never a
 * filesystem path, and is not serialised into API responses.
 */
export interface AssessmentDocument {
  id: string;
  assessmentId: string;
  type: DocumentType;
  status: DocumentStatus;

  /** As supplied by the client. Sanitised, retained for display only. */
  originalFilename: string;

  /** Resolved from file content, not from the client's claim. */
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;

  /** Null until preparation determines it. */
  pageCount: number | null;

  /** Populated by the PREPARING stage. */
  pages: PreparedPage[];

  storageKey: string;
  failure: DocumentFailure | null;

  uploadedAt: string;
  preparedAt: string | null;
}

/** The public projection of a document — no storage keys, no paths. */
export interface DocumentMetadata {
  id: string;
  assessmentId: string;
  type: DocumentType;
  status: DocumentStatus;
  originalFilename: string;
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  pageCount: number | null;
  failure: DocumentFailure | null;
  uploadedAt: string;
  preparedAt: string | null;
}

/** The public projection of a prepared page — geometry, no storage key. */
export interface PreparedPageMetadata {
  pageNumber: number;
  width: number;
  height: number;
  aspectRatio: number;
  sourceWidth: number;
  sourceHeight: number;
  scale: number;
  rotation: number;
  mimeType: string;
  sizeBytes: number;
}

export function toDocumentMetadata(document: AssessmentDocument): DocumentMetadata {
  return {
    id: document.id,
    assessmentId: document.assessmentId,
    type: document.type,
    status: document.status,
    originalFilename: document.originalFilename,
    format: document.format,
    mimeType: document.mimeType,
    sizeBytes: document.sizeBytes,
    pageCount: document.pageCount,
    failure: document.failure,
    uploadedAt: document.uploadedAt,
    preparedAt: document.preparedAt,
  };
}

export function toPreparedPageMetadata(page: PreparedPage): PreparedPageMetadata {
  return {
    pageNumber: page.pageNumber,
    width: page.width,
    height: page.height,
    aspectRatio: page.aspectRatio,
    sourceWidth: page.sourceWidth,
    sourceHeight: page.sourceHeight,
    scale: page.scale,
    rotation: page.rotation,
    mimeType: page.mimeType,
    sizeBytes: page.sizeBytes,
  };
}
