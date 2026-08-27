import { NextResponse } from 'next/server';
import { Readable } from 'node:stream';
import { toErrorResponse } from '@/lib/errors';
import {
  getDocument,
  readPreparedPageStream,
} from '@/lib/services/document/document-service';
import { PageParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string; documentId: string; pageNumber: string }>;
}

/**
 * GET /api/assessments/:assessmentId/documents/:documentId/pages/:pageNumber
 *
 * Serves the canonical prepared page bitmap. This is the development serving
 * mechanism for local storage: the page is addressed by document id and page
 * number, resolved through the storage abstraction, and streamed. No path
 * ever reaches the client, and no path from the client ever reaches storage.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId, documentId, pageNumber } = PageParamSchema.parse(
      await context.params,
    );

    const document = await getDocument(assessmentId, documentId);
    const { stream, page } = await readPreparedPageStream(document, pageNumber);

    return new NextResponse(Readable.toWeb(stream) as ReadableStream, {
      status: 200,
      headers: {
        'content-type': page.mimeType,
        'content-length': String(page.sizeBytes),
        // Prepared pages are immutable for the life of a document.
        'cache-control': 'private, max-age=3600, immutable',
        'x-page-width': String(page.width),
        'x-page-height': String(page.height),
      },
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
