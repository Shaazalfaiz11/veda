import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { openPdf } from '@/lib/services/document/pdf-preparation';
import { prepareImage } from '@/lib/services/document/image-preparation';
import { InvalidDocumentError } from '@/lib/errors';
import {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  makeGarbage,
  makeJpeg,
  makeMalformedPdf,
  makePdf,
  makePng,
  makeRotatedJpeg,
  makeTransparentPng,
} from '../fixtures/documents';
import {
  allowedDocumentTransitionsFrom,
  assertDocumentTransition,
  canTransitionDocument,
  isDocumentPrepared,
} from '@/lib/domain/document';
import { ConflictError } from '@/lib/errors';

const MAX_DIMENSION = 1000;

describe('PDF metadata extraction', () => {
  it('reports the page count', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT, A4_PORTRAIT, A4_LANDSCAPE]));
    try {
      expect(pdf.pageCount).toBe(3);
    } finally {
      await pdf.close();
    }
  });

  it('returns 1-based page numbers in original order', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT, A4_LANDSCAPE, A4_PORTRAIT]));
    try {
      const geometry = await pdf.geometry();
      expect(geometry.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    } finally {
      await pdf.close();
    }
  });

  it('preserves per-page dimensions, including a landscape page mid-document', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT, A4_LANDSCAPE, A4_PORTRAIT]));
    try {
      const geometry = await pdf.geometry();

      expect(geometry[0]).toMatchObject({ sourceWidth: 595, sourceHeight: 842 });
      expect(geometry[1]).toMatchObject({ sourceWidth: 842, sourceHeight: 595 });
      expect(geometry[2]).toMatchObject({ sourceWidth: 595, sourceHeight: 842 });
    } finally {
      await pdf.close();
    }
  });

  it('rejects a file that has a PDF signature but a corrupt body', async () => {
    await expect(openPdf(makeMalformedPdf())).rejects.toThrow(InvalidDocumentError);
  });

  it('rejects content that is not a PDF at all', async () => {
    await expect(openPdf(makeGarbage(256))).rejects.toThrow(InvalidDocumentError);
  });
});

describe('PDF page rendering', () => {
  it('renders a page to a real PNG bitmap', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT]));
    try {
      const page = await pdf.renderPage(1, MAX_DIMENSION);
      const metadata = await sharp(page.data).metadata();

      expect(metadata.format).toBe('png');
      expect(metadata.width).toBe(page.width);
      expect(metadata.height).toBe(page.height);
    } finally {
      await pdf.close();
    }
  });

  it('fits an oversized page inside the max-dimension box, preserving aspect ratio', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT]));
    try {
      // A4 is 842pt tall, so a 500px box actually constrains it.
      const page = await pdf.renderPage(1, 500);

      expect(Math.max(page.width, page.height)).toBe(500);
      expect(page.width / page.height).toBeCloseTo(595 / 842, 2);
    } finally {
      await pdf.close();
    }
  });

  it('records the scale it applied, so the transformation stays explicit', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT]));
    try {
      const page = await pdf.renderPage(1, 500);

      expect(page.scale).toBeCloseTo(500 / 842, 4);
      expect(page.sourceWidth).toBe(595);
      expect(page.sourceHeight).toBe(842);
      expect(Math.round(page.sourceWidth * page.scale)).toBe(page.width);
    } finally {
      await pdf.close();
    }
  });

  it('never enlarges a page smaller than the box — upscaling adds no information', async () => {
    const pdf = await openPdf(makePdf([{ width: 200, height: 300 }]));
    try {
      const page = await pdf.renderPage(1, MAX_DIMENSION);

      expect(page.scale).toBe(1);
      expect(page.width).toBe(200);
      expect(page.height).toBe(300);
    } finally {
      await pdf.close();
    }
  });

  it('renders a landscape page wider than it is tall', async () => {
    const pdf = await openPdf(makePdf([A4_LANDSCAPE]));
    try {
      const page = await pdf.renderPage(1, MAX_DIMENSION);
      expect(page.width).toBeGreaterThan(page.height);
    } finally {
      await pdf.close();
    }
  });

  it('rejects a page number outside the document', async () => {
    const pdf = await openPdf(makePdf([A4_PORTRAIT]));
    try {
      await expect(pdf.renderPage(2, MAX_DIMENSION)).rejects.toThrow(/out of range/);
      await expect(pdf.renderPage(0, MAX_DIMENSION)).rejects.toThrow(/out of range/);
    } finally {
      await pdf.close();
    }
  });

  it('produces identical bytes for the same page rendered twice', async () => {
    // Determinism is what lets a retry reuse a stored bitmap safely.
    const pdf = await openPdf(makePdf([A4_PORTRAIT]));
    try {
      const first = await pdf.renderPage(1, MAX_DIMENSION);
      const second = await pdf.renderPage(1, MAX_DIMENSION);

      expect(first.width).toBe(second.width);
      expect(first.height).toBe(second.height);
      expect(first.data.equals(second.data)).toBe(true);
    } finally {
      await pdf.close();
    }
  });
});

describe('image preparation', () => {
  it('normalizes a PNG into a single page', async () => {
    const page = await prepareImage(await makePng(800, 1200), MAX_DIMENSION);

    expect(page.pageNumber).toBe(1);
    expect(page.sourceWidth).toBe(800);
    expect(page.sourceHeight).toBe(1200);
  });

  it('normalizes a JPEG into the same shape a PDF page produces', async () => {
    const page = await prepareImage(await makeJpeg(640, 480), MAX_DIMENSION);

    expect(page).toMatchObject({ pageNumber: 1, sourceWidth: 640, sourceHeight: 480 });
    expect(await sharp(page.data).metadata()).toMatchObject({ format: 'png' });
  });

  it('fits an oversized scan inside the box without enlarging a small one', async () => {
    const large = await prepareImage(await makePng(4000, 3000), MAX_DIMENSION);
    expect(Math.max(large.width, large.height)).toBe(MAX_DIMENSION);

    const small = await prepareImage(await makePng(300, 200), MAX_DIMENSION);
    expect(small.scale).toBe(1);
    expect(small.width).toBe(300);
  });

  it('bakes EXIF orientation into the pixels', async () => {
    // A 400x200 photo tagged "rotate 90" displays as 200x400. Without this,
    // recorded geometry would describe the stored bytes rather than the page
    // the teacher sees, and every coordinate would be measured wrongly.
    const page = await prepareImage(await makeRotatedJpeg(400, 200), MAX_DIMENSION);

    expect(page.sourceWidth).toBe(200);
    expect(page.sourceHeight).toBe(400);
    expect(page.rotation).toBe(90);

    const metadata = await sharp(page.data).metadata();
    expect(metadata.width).toBe(200);
    expect(metadata.height).toBe(400);
  });

  it('flattens transparency onto white rather than black', async () => {
    const page = await prepareImage(await makeTransparentPng(50, 50), MAX_DIMENSION);
    const { data, info } = await sharp(page.data)
      .raw()
      .toBuffer({ resolveWithObject: true });

    expect(info.channels).toBeGreaterThanOrEqual(3);
    expect(data[0]).toBe(255);
    expect(data[1]).toBe(255);
    expect(data[2]).toBe(255);
  });

  it('computes the aspect ratio from the prepared bitmap', async () => {
    const page = await prepareImage(await makePng(1600, 900), MAX_DIMENSION);
    expect(page.width / page.height).toBeCloseTo(16 / 9, 2);
  });

  it('rejects content that is not an image', async () => {
    await expect(prepareImage(makeGarbage(128), MAX_DIMENSION)).rejects.toThrow(
      InvalidDocumentError,
    );
  });
});

describe('document state transitions', () => {
  it('follows UPLOADED -> PREPARING -> READY', () => {
    expect(canTransitionDocument('UPLOADED', 'PREPARING')).toBe(true);
    expect(canTransitionDocument('PREPARING', 'READY')).toBe(true);
  });

  it('allows failure from UPLOADED and PREPARING', () => {
    expect(canTransitionDocument('UPLOADED', 'FAILED')).toBe(true);
    expect(canTransitionDocument('PREPARING', 'FAILED')).toBe(true);
  });

  it('allows a failed document to be re-prepared', () => {
    expect(canTransitionDocument('FAILED', 'PREPARING')).toBe(true);
  });

  it('marks READY as prepared', () => {
    expect(isDocumentPrepared('READY')).toBe(true);
    expect(isDocumentPrepared('FAILED')).toBe(false);
    expect(isDocumentPrepared('UPLOADED')).toBe(false);
  });

  it('lets a READY document be re-prepared when its bitmaps go missing', () => {
    // READY is the success state, not a dead end: a document that has lost
    // its stored pages is no longer genuinely prepared.
    expect(canTransitionDocument('READY', 'PREPARING')).toBe(true);
    expect(allowedDocumentTransitionsFrom('READY')).toEqual(['PREPARING']);
  });

  it('never rewinds a document to UPLOADED', () => {
    expect(canTransitionDocument('READY', 'UPLOADED')).toBe(false);
    expect(canTransitionDocument('PREPARING', 'UPLOADED')).toBe(false);
  });

  it('rejects skipping preparation entirely', () => {
    expect(canTransitionDocument('UPLOADED', 'READY')).toBe(false);
    expect(() => assertDocumentTransition('UPLOADED', 'READY')).toThrow(ConflictError);
  });

  it('rejects skipping from FAILED straight to READY', () => {
    expect(() => assertDocumentTransition('FAILED', 'READY')).toThrow(ConflictError);
  });
});
