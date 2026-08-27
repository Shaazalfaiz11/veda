import { ValidationError } from '@/lib/errors';

/**
 * Storage keys.
 *
 * A key is an opaque, server-generated handle — never a filesystem path and
 * never derived from a client-supplied filename. Keys are built only from
 * UUIDs and fixed literals, which is what makes traversal structurally
 * impossible rather than merely filtered out.
 *
 *   assessments/{assessmentId}/{documentId}/original
 *   assessments/{assessmentId}/{documentId}/pages/{pageNumber}.png
 */

/** Only these characters may appear in a key. Note: no dots, no backslashes. */
const KEY_SEGMENT = /^[A-Za-z0-9_-]+$/;
const KEY_PATTERN = /^[A-Za-z0-9_/-]+(\.[A-Za-z0-9]+)?$/;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function assertUuid(value: string, label: string): void {
  if (!UUID.test(value)) {
    throw new ValidationError(`${label} must be a UUID to form a storage key.`);
  }
}

export function originalDocumentKey(assessmentId: string, documentId: string): string {
  assertUuid(assessmentId, 'assessmentId');
  assertUuid(documentId, 'documentId');
  return `assessments/${assessmentId}/${documentId}/original`;
}

export function preparedPageKey(
  assessmentId: string,
  documentId: string,
  pageNumber: number,
): string {
  assertUuid(assessmentId, 'assessmentId');
  assertUuid(documentId, 'documentId');

  if (!Number.isInteger(pageNumber) || pageNumber < 1) {
    throw new ValidationError('pageNumber must be a positive integer to form a storage key.');
  }

  return `assessments/${assessmentId}/${documentId}/pages/${pageNumber}.png`;
}

export function documentPrefix(assessmentId: string, documentId: string): string {
  assertUuid(assessmentId, 'assessmentId');
  assertUuid(documentId, 'documentId');
  return `assessments/${assessmentId}/${documentId}`;
}

/**
 * Validates a key before it reaches any storage backend.
 *
 * Rejects absolute paths, traversal segments, backslashes, NUL bytes and
 * empty segments. This is defence in depth — keys are generated internally,
 * but a provider must never assume its caller was careful.
 */
export function assertSafeKey(key: string): void {
  if (typeof key !== 'string' || key.length === 0) {
    throw new ValidationError('Storage key must be a non-empty string.');
  }

  if (key.length > 512) {
    throw new ValidationError('Storage key is too long.');
  }

  if (key.includes('\0')) {
    throw new ValidationError('Storage key must not contain NUL bytes.');
  }

  if (key.includes('\\')) {
    throw new ValidationError('Storage key must not contain backslashes.');
  }

  if (key.startsWith('/') || /^[A-Za-z]:/.test(key)) {
    throw new ValidationError('Storage key must be relative.');
  }

  if (!KEY_PATTERN.test(key)) {
    throw new ValidationError('Storage key contains unsupported characters.');
  }

  for (const segment of key.split('/')) {
    if (segment.length === 0) {
      throw new ValidationError('Storage key must not contain empty segments.');
    }
    if (segment === '.' || segment === '..') {
      throw new ValidationError('Storage key must not contain traversal segments.');
    }
    // Strip a single trailing extension before checking the segment charset.
    const stem = segment.includes('.') ? segment.slice(0, segment.lastIndexOf('.')) : segment;
    if (!KEY_SEGMENT.test(stem)) {
      throw new ValidationError('Storage key contains unsupported characters.');
    }
  }
}

/**
 * Reduces a client-supplied filename to something safe to store as display
 * metadata. The result is never used to build a path — it exists only so the
 * teacher sees a recognisable name in the UI.
 */
export function sanitizeFilename(filename: string, fallback = 'document'): string {
  const base = filename.split(/[\\/]/).pop() ?? '';

  const cleaned = base
    .replace(/\0/g, '')
    .replace(/[^A-Za-z0-9._-]/g, '_')
    .replace(/^\.+/, '')
    .slice(0, 255)
    .trim();

  return cleaned.length > 0 ? cleaned : fallback;
}
