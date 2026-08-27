import { NotFoundError } from '@/lib/errors';
import { getDocumentStorage } from '@/lib/storage';
import { getDocument } from '@/lib/services/document/document-service';
import type { DocumentProvider, LoadedDocument, PreparedPageImage } from './types';

/**
 * Read side of the document store.
 *
 * Later AI stages fetch canonical page bitmaps through this interface, so
 * they never learn where bytes physically live and never render their own
 * version of a page.
 */
export class LocalDocumentProvider implements DocumentProvider {
  readonly name = 'local-document-provider';

  async load(assessmentId: string, documentId: string): Promise<LoadedDocument> {
    const document = await getDocument(assessmentId, documentId);

    if (document.status !== 'READY' || document.pageCount === null) {
      throw new NotFoundError(`Document ${documentId} has not been prepared yet.`);
    }

    return {
      id: document.id,
      assessmentId: document.assessmentId,
      type: document.type,
      pageCount: document.pageCount,
      pages: document.pages,
    };
  }

  async getPageImage(
    assessmentId: string,
    documentId: string,
    pageNumber: number,
  ): Promise<PreparedPageImage> {
    const document = await getDocument(assessmentId, documentId);
    const page = document.pages.find((candidate) => candidate.pageNumber === pageNumber);

    if (!page) {
      throw new NotFoundError(`Page ${pageNumber} is not available for document ${documentId}.`);
    }

    return {
      documentId,
      pageNumber,
      width: page.width,
      height: page.height,
      mimeType: page.mimeType,
      data: await getDocumentStorage().get(page.storageKey),
    };
  }

  async getPageImages(assessmentId: string, documentId: string): Promise<PreparedPageImage[]> {
    const loaded = await this.load(assessmentId, documentId);
    const images: PreparedPageImage[] = [];

    // Sequential: a many-page document loaded in parallel would hold every
    // bitmap in memory at once.
    for (const page of loaded.pages) {
      images.push(await this.getPageImage(assessmentId, documentId, page.pageNumber));
    }

    return images;
  }
}

export function getDocumentProvider(): DocumentProvider {
  return new LocalDocumentProvider();
}
