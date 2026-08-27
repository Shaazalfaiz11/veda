/**
 * Error taxonomy.
 *
 * The distinction that matters operationally is `retryable`. A transient
 * failure (Redis blip, model timeout) should be retried with backoff; a
 * permanent one (bad input, unknown assessment) must not be, or the queue
 * burns its whole attempt budget re-running something that cannot succeed.
 */
export type ErrorCode =
  | 'VALIDATION_ERROR'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'DEPENDENCY_UNAVAILABLE'
  | 'INTERNAL_ERROR'
  | 'DOCUMENT_TOO_LARGE'
  | 'UNSUPPORTED_DOCUMENT_TYPE'
  | 'INVALID_DOCUMENT'
  | 'EMPTY_DOCUMENT'
  | 'DOCUMENT_PROCESSING_FAILED';

export abstract class AppError extends Error {
  abstract readonly code: ErrorCode;
  abstract readonly httpStatus: number;
  abstract readonly retryable: boolean;

  readonly details?: unknown;

  constructor(message: string, details?: unknown) {
    super(message);
    this.name = new.target.name;
    this.details = details;
    Error.captureStackTrace?.(this, new.target);
  }
}

/** Bad input. Never retried — replaying it produces the same failure. */
export class ValidationError extends AppError {
  readonly code = 'VALIDATION_ERROR' as const;
  readonly httpStatus = 400;
  readonly retryable = false;
}

/** The referenced resource does not exist. Never retried. */
export class NotFoundError extends AppError {
  readonly code = 'NOT_FOUND' as const;
  readonly httpStatus = 404;
  readonly retryable = false;
}

/** The resource exists but is not in a state that permits this action. */
export class ConflictError extends AppError {
  readonly code = 'CONFLICT' as const;
  readonly httpStatus = 409;
  readonly retryable = false;
}

/** An upstream dependency failed in a way that may succeed on retry. */
export class DependencyUnavailableError extends AppError {
  readonly code = 'DEPENDENCY_UNAVAILABLE' as const;
  readonly httpStatus = 503;
  readonly retryable = true;
}

/** Unclassified failure. Retried, on the assumption it may be transient. */
export class InternalError extends AppError {
  readonly code = 'INTERNAL_ERROR' as const;
  readonly httpStatus = 500;
  readonly retryable = true;
}

export function isAppError(error: unknown): error is AppError {
  return error instanceof AppError;
}

/**
 * Whether the queue should re-attempt this job. Unknown errors are treated
 * as retryable so a genuine blip is not discarded on its first occurrence.
 */
export function isRetryable(error: unknown): boolean {
  return isAppError(error) ? error.retryable : true;
}

// ---------------------------------------------------------------------------
// Document ingestion
// ---------------------------------------------------------------------------

/** Upload exceeded the configured size ceiling. Never retried. */
export class DocumentTooLargeError extends AppError {
  readonly code = 'DOCUMENT_TOO_LARGE' as const;
  readonly httpStatus = 413;
  readonly retryable = false;
}

/** Content is not a format the server is willing to prepare. Never retried. */
export class UnsupportedDocumentTypeError extends AppError {
  readonly code = 'UNSUPPORTED_DOCUMENT_TYPE' as const;
  readonly httpStatus = 415;
  readonly retryable = false;
}

/** Content claims a supported format but cannot be parsed. Never retried. */
export class InvalidDocumentError extends AppError {
  readonly code = 'INVALID_DOCUMENT' as const;
  readonly httpStatus = 422;
  readonly retryable = false;
}

/** Zero-byte upload. Never retried. */
export class EmptyDocumentError extends AppError {
  readonly code = 'EMPTY_DOCUMENT' as const;
  readonly httpStatus = 422;
  readonly retryable = false;
}

/**
 * Preparation failed for a reason that may not recur — a transient I/O or
 * memory condition. Retried, so the queue can re-drive it.
 */
export class DocumentProcessingFailedError extends AppError {
  readonly code = 'DOCUMENT_PROCESSING_FAILED' as const;
  readonly httpStatus = 500;
  readonly retryable = true;
}
