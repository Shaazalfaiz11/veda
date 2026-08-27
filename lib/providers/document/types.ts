import type { AssessmentDocument, DocumentType, PreparedPage } from '@/lib/domain/document';

/**
 * Document provider contract — access to prepared documents and their page
 * bitmaps.
 *
 * Preparation itself is a service (see `lib/services/document`); this
 * interface is the read side that later AI stages use to fetch the canonical
 * page bitmaps. Keeping it behind an interface means the extraction stages
 * never learn where bytes physically live.
 */
export interface LoadedDocument {
  id: string;
  assessmentId: string;
  type: DocumentType;
  pageCount: number;
  pages: PreparedPage[];
}

/** A prepared page bitmap, ready to hand to a vision model. */
export interface PreparedPageImage {
  documentId: string;
  pageNumber: number;
  width: number;
  height: number;
  mimeType: string;
  data: Buffer;
}

export interface DocumentProvider {
  readonly name: string;

  load(assessmentId: string, documentId: string): Promise<LoadedDocument>;
  getPageImage(
    assessmentId: string,
    documentId: string,
    pageNumber: number,
  ): Promise<PreparedPageImage>;
  getPageImages(assessmentId: string, documentId: string): Promise<PreparedPageImage[]>;
}

export type { AssessmentDocument };
