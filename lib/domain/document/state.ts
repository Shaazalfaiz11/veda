import { ConflictError } from '@/lib/errors';
import type { DocumentStatus } from './types';

/**
 * Document lifecycle transitions.
 *
 * READY is the success state but not a dead end: a document whose prepared
 * bitmaps have gone missing from storage is no longer genuinely prepared, and
 * preparation must be able to re-drive it. FAILED likewise returns to
 * PREPARING so the assessment-level retry can have another attempt.
 *
 * UPLOADED is never returned to — a new upload creates a new document rather
 * than rewinding this one.
 */
const ALLOWED_TRANSITIONS: Record<DocumentStatus, readonly DocumentStatus[]> = {
  UPLOADED: ['PREPARING', 'FAILED'],
  PREPARING: ['READY', 'FAILED'],
  READY: ['PREPARING'],
  FAILED: ['PREPARING'],
};

export function canTransitionDocument(from: DocumentStatus, to: DocumentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertDocumentTransition(from: DocumentStatus, to: DocumentStatus): void {
  if (!canTransitionDocument(from, to)) {
    throw new ConflictError(`Cannot transition document from ${from} to ${to}.`, {
      from,
      to,
      allowed: ALLOWED_TRANSITIONS[from],
    });
  }
}

export function allowedDocumentTransitionsFrom(
  status: DocumentStatus,
): readonly DocumentStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

/** Whether the document has usable prepared pages right now. */
export function isDocumentPrepared(status: DocumentStatus): boolean {
  return status === 'READY';
}
