import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { toDocumentMetadata, toPreparedPageMetadata } from '@/lib/domain/document';
import { getDocument } from '@/lib/services/document/document-service';
import { DocumentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string; documentId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/documents/:documentId
 *
 * Document metadata plus prepared page geometry. Storage keys are stripped:
 * a client addresses a page by number, never by location.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId, documentId } = DocumentIdParamSchema.parse(await context.params);
    const document = await getDocument(assessmentId, documentId);

    return NextResponse.json({
      ...toDocumentMetadata(document),
      pages: document.pages.map((page) => ({
        ...toPreparedPageMetadata(page),
        url: `/api/assessments/${assessmentId}/documents/${documentId}/pages/${page.pageNumber}`,
      })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
