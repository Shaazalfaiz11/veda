import { describe, expect, it } from 'vitest';
import {
  SNIFF_LENGTH,
  formatFromExtension,
  formatFromMimeType,
  sniffFormat,
  validateUpload,
} from '@/lib/services/document/file-validation';
import {
  DocumentTooLargeError,
  EmptyDocumentError,
  UnsupportedDocumentTypeError,
} from '@/lib/errors';
import { A4_PORTRAIT, makeGarbage, makeJpeg, makePdf, makePng } from '../fixtures/documents';

const pdf = makePdf([A4_PORTRAIT]);

async function heads() {
  return {
    pdf: pdf.subarray(0, SNIFF_LENGTH),
    png: (await makePng(10, 10)).subarray(0, SNIFF_LENGTH),
    jpeg: (await makeJpeg(10, 10)).subarray(0, SNIFF_LENGTH),
    garbage: makeGarbage().subarray(0, SNIFF_LENGTH),
  };
}

describe('content sniffing', () => {
  it('identifies each supported format from its leading bytes', async () => {
    const head = await heads();
    expect(sniffFormat(head.pdf)).toBe('PDF');
    expect(sniffFormat(head.png)).toBe('PNG');
    expect(sniffFormat(head.jpeg)).toBe('JPEG');
  });

  it('returns null for content matching no signature', async () => {
    expect(sniffFormat((await heads()).garbage)).toBeNull();
  });

  it('returns null for a buffer too short to identify', () => {
    expect(sniffFormat(Buffer.from([0x25, 0x50]))).toBeNull();
  });

  it('is not fooled by a signature appearing later in the file', () => {
    const buried = Buffer.concat([Buffer.from('junk'), Buffer.from('%PDF-')]);
    expect(sniffFormat(buried)).toBeNull();
  });
});

describe('claim parsing', () => {
  it('maps known extensions, case-insensitively', () => {
    expect(formatFromExtension('paper.pdf')).toBe('PDF');
    expect(formatFromExtension('scan.PNG')).toBe('PNG');
    expect(formatFromExtension('photo.JPG')).toBe('JPEG');
    expect(formatFromExtension('photo.jpeg')).toBe('JPEG');
  });

  it('returns null for unknown or absent extensions', () => {
    expect(formatFromExtension('archive.zip')).toBeNull();
    expect(formatFromExtension('noextension')).toBeNull();
    expect(formatFromExtension(null)).toBeNull();
  });

  it('maps MIME types and ignores parameters', () => {
    expect(formatFromMimeType('application/pdf')).toBe('PDF');
    expect(formatFromMimeType('image/jpeg; charset=binary')).toBe('JPEG');
    expect(formatFromMimeType('IMAGE/PNG')).toBe('PNG');
    expect(formatFromMimeType('application/zip')).toBeNull();
  });
});

describe('upload validation', () => {
  it('accepts a well-formed PDF', async () => {
    const result = validateUpload({
      head: (await heads()).pdf,
      sizeBytes: pdf.byteLength,
      declaredMimeType: 'application/pdf',
      filename: 'paper.pdf',
    });

    expect(result.format).toBe('PDF');
    expect(result.mimeType).toBe('application/pdf');
    expect(result.claimMismatch).toBe(false);
  });

  it('rejects an empty file', () => {
    expect(() =>
      validateUpload({ head: Buffer.alloc(0), sizeBytes: 0, filename: 'empty.pdf' }),
    ).toThrow(EmptyDocumentError);
  });

  it('rejects a file that claims a size but has no bytes', () => {
    expect(() =>
      validateUpload({ head: Buffer.alloc(0), sizeBytes: 100, filename: 'x.pdf' }),
    ).toThrow(EmptyDocumentError);
  });

  it('rejects a file over the configured ceiling', async () => {
    const head = (await heads()).pdf;

    expect(() =>
      // The test environment ceiling is 10 MB.
      validateUpload({ head, sizeBytes: 11 * 1024 * 1024, filename: 'huge.pdf' }),
    ).toThrow(DocumentTooLargeError);
  });

  it('checks size before content, so a huge upload is refused cheaply', () => {
    // Garbage content would also fail, but size is the error that surfaces.
    expect(() =>
      validateUpload({ head: makeGarbage(), sizeBytes: 50 * 1024 * 1024, filename: 'x.bin' }),
    ).toThrow(DocumentTooLargeError);
  });

  it('rejects an unsupported format regardless of what the client claims', () => {
    expect(() =>
      validateUpload({
        head: makeGarbage(),
        sizeBytes: 64,
        declaredMimeType: 'application/pdf',
        filename: 'definitely-a.pdf',
      }),
    ).toThrow(UnsupportedDocumentTypeError);
  });

  it('trusts content over a lying extension', async () => {
    const result = validateUpload({
      head: (await heads()).png,
      sizeBytes: 2048,
      declaredMimeType: 'image/png',
      filename: 'actually-a-png.pdf',
    });

    expect(result.format).toBe('PNG');
    expect(result.claimMismatch).toBe(true);
  });

  it('trusts content over a lying MIME type', async () => {
    const result = validateUpload({
      head: (await heads()).jpeg,
      sizeBytes: 2048,
      declaredMimeType: 'application/pdf',
      filename: 'photo.jpg',
    });

    expect(result.format).toBe('JPEG');
    expect(result.mimeType).toBe('image/jpeg');
    expect(result.claimMismatch).toBe(true);
  });

  it('accepts a file with no claims at all', async () => {
    const result = validateUpload({
      head: (await heads()).png,
      sizeBytes: 1024,
      declaredMimeType: null,
      filename: null,
    });

    expect(result.format).toBe('PNG');
    expect(result.claimMismatch).toBe(false);
  });
});
