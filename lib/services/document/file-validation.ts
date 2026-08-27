import {
  DocumentTooLargeError,
  EmptyDocumentError,
  UnsupportedDocumentTypeError,
} from '@/lib/errors';
import { getEnv } from '@/lib/config';
import {
  EXTENSION_TO_FORMAT,
  FORMAT_TO_MIME,
  MIME_TO_FORMAT,
  type DocumentFormat,
} from '@/lib/domain/document';

/**
 * File validation.
 *
 * The client's declared MIME type and the filename extension are both
 * treated as hints. The format is decided by inspecting the leading bytes,
 * because that is the only signal an attacker cannot simply relabel. A
 * mismatch between content and claim is not fatal on its own — content wins
 * — but content that matches nothing supported is refused.
 */

/** Magic byte signatures, longest first so a prefix cannot shadow a longer match. */
const SIGNATURES: ReadonlyArray<{ format: DocumentFormat; bytes: readonly number[] }> = [
  { format: 'PNG', bytes: [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a] },
  { format: 'PDF', bytes: [0x25, 0x50, 0x44, 0x46, 0x2d] }, // "%PDF-"
  { format: 'JPEG', bytes: [0xff, 0xd8, 0xff] },
];

/** Bytes needed to identify any supported format. */
export const SNIFF_LENGTH = 8;

export interface ValidationInput {
  /** Leading bytes of the upload. At least SNIFF_LENGTH where available. */
  head: Buffer;
  sizeBytes: number;
  declaredMimeType?: string | null;
  filename?: string | null;
}

export interface ValidatedFile {
  format: DocumentFormat;
  mimeType: string;
  sizeBytes: number;
  /** True when the client's claims disagreed with the actual content. */
  claimMismatch: boolean;
}

/** Identifies a format from leading bytes, or null if nothing matches. */
export function sniffFormat(head: Buffer): DocumentFormat | null {
  for (const signature of SIGNATURES) {
    if (head.length < signature.bytes.length) continue;

    let matched = true;
    for (let i = 0; i < signature.bytes.length; i += 1) {
      if (head[i] !== signature.bytes[i]) {
        matched = false;
        break;
      }
    }

    if (matched) return signature.format;
  }

  return null;
}

export function formatFromExtension(filename: string | null | undefined): DocumentFormat | null {
  if (!filename) return null;
  const dot = filename.lastIndexOf('.');
  if (dot < 0) return null;
  return EXTENSION_TO_FORMAT[filename.slice(dot).toLowerCase()] ?? null;
}

export function formatFromMimeType(mimeType: string | null | undefined): DocumentFormat | null {
  if (!mimeType) return null;
  // Strip any parameters, e.g. "image/jpeg; charset=binary".
  const bare = mimeType.split(';')[0]?.trim().toLowerCase() ?? '';
  return MIME_TO_FORMAT[bare] ?? null;
}

/**
 * Applies every gate an upload must pass before it is stored.
 *
 * Order matters: emptiness and size are checked before content, so a
 * hostile 2 GB upload is rejected on cheap facts rather than after being
 * inspected.
 */
export function validateUpload(input: ValidationInput): ValidatedFile {
  const { MAX_DOCUMENT_BYTES } = getEnv();

  if (input.sizeBytes <= 0 || input.head.length === 0) {
    throw new EmptyDocumentError('The uploaded document is empty.');
  }

  if (input.sizeBytes > MAX_DOCUMENT_BYTES) {
    throw new DocumentTooLargeError(
      `The document exceeds the maximum size of ${MAX_DOCUMENT_BYTES} bytes.`,
      { maxBytes: MAX_DOCUMENT_BYTES, sizeBytes: input.sizeBytes },
    );
  }

  const actual = sniffFormat(input.head);

  if (actual === null) {
    throw new UnsupportedDocumentTypeError(
      'The document is not a supported format. Accepted formats are PDF, PNG and JPEG.',
      { accepted: Object.keys(MIME_TO_FORMAT) },
    );
  }

  const claimedByMime = formatFromMimeType(input.declaredMimeType);
  const claimedByExtension = formatFromExtension(input.filename);

  const claimMismatch =
    (claimedByMime !== null && claimedByMime !== actual) ||
    (claimedByExtension !== null && claimedByExtension !== actual);

  return {
    format: actual,
    mimeType: FORMAT_TO_MIME[actual],
    sizeBytes: input.sizeBytes,
    claimMismatch,
  };
}
