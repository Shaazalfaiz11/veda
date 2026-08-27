import { createRequire } from 'node:module';
import { InvalidDocumentError, ValidationError } from '@/lib/errors';

/**
 * PDF preparation.
 *
 * pdf.js reads the page tree for geometry and rasterises each page onto a
 * canvas. Page numbers are 1-based and follow the document's own page order;
 * nothing here reorders, crops or rotates beyond applying the rotation the
 * PDF itself declares, which pdf.js folds into the viewport so the prepared
 * bitmap is the page as a reader would see it.
 */

const require = createRequire(import.meta.url);

export interface PdfPageGeometry {
  pageNumber: number;
  /** Page box in PDF points, with the page's own rotation applied. */
  sourceWidth: number;
  sourceHeight: number;
  /** Rotation declared by the PDF, in degrees. */
  rotation: number;
}

export interface RenderedPage {
  pageNumber: number;
  data: Buffer;
  width: number;
  height: number;
  scale: number;
  sourceWidth: number;
  sourceHeight: number;
  rotation: number;
}

/** Minimal shape of the pdf.js pieces used here. */
interface PdfDocumentHandle {
  numPages: number;
  getPage(pageNumber: number): Promise<PdfPageHandle>;
}

interface PdfPageHandle {
  rotate: number;
  getViewport(options: { scale: number }): { width: number; height: number };
  render(options: Record<string, unknown>): { promise: Promise<void> };
  cleanup(): void;
}

interface LoadingTask {
  promise: Promise<PdfDocumentHandle>;
  destroy(): Promise<void>;
}

type PdfjsModule = {
  getDocument(options: Record<string, unknown>): LoadingTask;
};

let pdfjsPromise: Promise<PdfjsModule> | null = null;

/** pdf.js is loaded lazily so importing this module stays cheap. */
async function loadPdfjs(): Promise<PdfjsModule> {
  pdfjsPromise ??= import('pdfjs-dist/legacy/build/pdf.mjs') as unknown as Promise<PdfjsModule>;
  return pdfjsPromise;
}

/** Directory pdf.js reads its bundled standard fonts from. */
function standardFontDataUrl(): string {
  const packageJson = require.resolve('pdfjs-dist/package.json');
  return packageJson.replace(/package\.json$/, 'standard_fonts/');
}

/**
 * Opens a PDF for preparation. The caller must always call `close()`, which
 * releases pdf.js's internal buffers.
 */
export async function openPdf(data: Buffer): Promise<{
  pageCount: number;
  geometry(): Promise<PdfPageGeometry[]>;
  renderPage(pageNumber: number, maxDimension: number): Promise<RenderedPage>;
  close(): Promise<void>;
}> {
  const pdfjs = await loadPdfjs();

  // pdf.js takes ownership of the array it is given, so hand it a copy —
  // otherwise the caller's buffer is detached underneath them.
  const bytes = new Uint8Array(data);

  let task: LoadingTask;
  let document: PdfDocumentHandle;

  try {
    task = pdfjs.getDocument({
      data: bytes,
      // Untrusted input: no scripting, no eval, no network font fetches.
      isEvalSupported: false,
      useSystemFonts: false,
      disableAutoFetch: true,
      standardFontDataUrl: standardFontDataUrl(),
    });
    document = await task.promise;
  } catch (error) {
    throw new InvalidDocumentError('The PDF could not be parsed.', {
      reason: error instanceof Error ? error.message : 'unknown',
    });
  }

  if (document.numPages < 1) {
    await task.destroy();
    throw new InvalidDocumentError('The PDF contains no pages.');
  }

  return {
    pageCount: document.numPages,

    async geometry(): Promise<PdfPageGeometry[]> {
      const pages: PdfPageGeometry[] = [];

      for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
        const page = await document.getPage(pageNumber);
        const viewport = page.getViewport({ scale: 1 });

        pages.push({
          pageNumber,
          sourceWidth: viewport.width,
          sourceHeight: viewport.height,
          rotation: page.rotate,
        });

        page.cleanup();
      }

      return pages;
    },

    async renderPage(pageNumber: number, maxDimension: number): Promise<RenderedPage> {
      if (pageNumber < 1 || pageNumber > document.numPages) {
        throw new ValidationError(`Page ${pageNumber} is out of range for this document.`);
      }

      const { createCanvas } = require('@napi-rs/canvas') as typeof import('@napi-rs/canvas');

      const page = await document.getPage(pageNumber);

      try {
        const base = page.getViewport({ scale: 1 });

        // Fit the page inside the max-dimension box. Never upscale: enlarging
        // a small scan adds pixels without adding information.
        const scale = Math.min(1, maxDimension / Math.max(base.width, base.height));
        const viewport = page.getViewport({ scale });

        const width = Math.max(1, Math.round(viewport.width));
        const height = Math.max(1, Math.round(viewport.height));

        const canvas = createCanvas(width, height);
        const context = canvas.getContext('2d');

        // Scanned pages often have transparent margins; a white ground keeps
        // the prepared bitmap looking like paper rather than a checkerboard.
        context.fillStyle = '#ffffff';
        context.fillRect(0, 0, width, height);

        await page.render({ canvasContext: context, viewport, canvas }).promise;

        return {
          pageNumber,
          data: canvas.toBuffer('image/png'),
          width,
          height,
          scale,
          sourceWidth: base.width,
          sourceHeight: base.height,
          rotation: page.rotate,
        };
      } finally {
        page.cleanup();
      }
    },

    async close(): Promise<void> {
      await task.destroy();
    },
  };
}
