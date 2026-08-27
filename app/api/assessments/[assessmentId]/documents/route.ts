import { NextResponse } from 'next/server';
import { DocumentTooLargeError, toErrorResponse, ValidationError } from '@/lib/errors';
import { getEnv } from '@/lib/config';
import { toDocumentMetadata, toPreparedPageMetadata } from '@/lib/domain/document';
import { listDocuments, uploadDocument } from '@/lib/services/document/document-service';
import { AssessmentIdParamSchema, UploadDocumentSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * POST /api/assessments/:assessmentId/documents
 *
 * Accepts one file as multipart/form-data with fields `type` and `file`.
 * Stores it and returns metadata — never the bytes, never a storage path.
 * No preparation happens here; that is the worker's job.
 */
export async function POST(request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);

    const contentType = request.headers.get('content-type') ?? '';
    if (!contentType.toLowerCase().includes('multipart/form-data')) {
      throw new ValidationError('Upload must be sent as multipart/form-data.');
    }

    let form: FormData;
    try {
      form = await request.formData();
    } catch {
      throw new ValidationError('The multipart body could not be parsed.');
    }

    const { type } = UploadDocumentSchema.parse({ type: form.get('type') });

    const file = form.get('file');
    if (!(file instanceof File)) {
      throw new ValidationError('A file field is required.');
    }

    // Reject on the declared length before reading the body, so an oversized
    // upload is not materialised in memory just to be refused.
    const { MAX_DOCUMENT_BYTES } = getEnv();
    if (file.size > MAX_DOCUMENT_BYTES) {
      throw new DocumentTooLargeError(
        `The document exceeds the maximum size of ${MAX_DOCUMENT_BYTES} bytes.`,
        { maxBytes: MAX_DOCUMENT_BYTES, sizeBytes: file.size },
      );
    }

    const data = Buffer.from(await file.arrayBuffer());

    const document = await uploadDocument({
      assessmentId,
      type,
      filename: file.name || null,
      declaredMimeType: file.type || null,
      data,
    });

    return NextResponse.json(document, { status: 201 });
  } catch (error) {
    return toErrorResponse(error);
  }
}

/** GET /api/assessments/:assessmentId/documents — metadata for every document. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const documents = await listDocuments(assessmentId);

    return NextResponse.json({
      assessmentId,
      documents: documents.map((document) => ({
        ...toDocumentMetadata(document),
        pages: document.pages.map(toPreparedPageMetadata),
      })),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
