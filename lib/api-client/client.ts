import type {
  Answer,
  AssessmentStatusView,
  ApiErrorBody,
  CreatedAssessment,
  DocumentMetadata,
  DocumentType,
  DocumentWithPages,
  GradeItem,
  GradingSummary,
  MappingEntry,
  ProcessingTicket,
  Question,
  ReviewItem,
} from './types';

/**
 * Browser-side wrappers over the existing API routes.
 *
 * Nothing here reshapes the backend. Each function is one request to one
 * route that already exists, so the UI reads exactly what the pipeline wrote
 * and there is no second place where a mapping or a mark could be computed.
 */

/** Carries the server's error code so a caller can react to it, not just show it. */
export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly details: unknown;

  constructor(message: string, code: string, status: number, details?: unknown) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
    this.status = status;
    this.details = details;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const response = await fetch(path, {
    ...init,
    headers: {
      Accept: 'application/json',
      ...(init?.headers ?? {}),
    },
  });

  if (!response.ok) {
    // A route can still fail before its JSON envelope is written — a proxy
    // timeout, say — so an unparseable body must not mask the real status.
    let body: ApiErrorBody | null = null;
    try {
      body = (await response.json()) as ApiErrorBody;
    } catch {
      body = null;
    }

    throw new ApiError(
      body?.error?.message ?? `Request failed with status ${response.status}.`,
      body?.error?.code ?? 'UNKNOWN',
      response.status,
      body?.error?.details,
    );
  }

  return (await response.json()) as T;
}

export function createAssessment(title?: string): Promise<CreatedAssessment> {
  return request<CreatedAssessment>('/api/assessments', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ title: title ?? null }),
  });
}

export function uploadDocument(
  assessmentId: string,
  type: DocumentType,
  file: File,
): Promise<DocumentMetadata> {
  const form = new FormData();
  form.set('type', type);
  form.set('file', file);

  // No Content-Type header: the browser must set the multipart boundary.
  return request<DocumentMetadata>(`/api/assessments/${assessmentId}/documents`, {
    method: 'POST',
    body: form,
  });
}

export function startProcessing(assessmentId: string): Promise<ProcessingTicket> {
  return request<ProcessingTicket>(`/api/assessments/${assessmentId}/process`, {
    method: 'POST',
  });
}

export function getStatus(assessmentId: string): Promise<AssessmentStatusView> {
  return request<AssessmentStatusView>(`/api/assessments/${assessmentId}/status`, {
    cache: 'no-store',
  });
}

export function getDocuments(
  assessmentId: string,
): Promise<{ assessmentId: string; documents: DocumentWithPages[] }> {
  return request(`/api/assessments/${assessmentId}/documents`, { cache: 'no-store' });
}

export function getQuestions(
  assessmentId: string,
): Promise<{ questionCount: number; questions: Question[] }> {
  return request(`/api/assessments/${assessmentId}/questions`, { cache: 'no-store' });
}

export function getAnswers(
  assessmentId: string,
): Promise<{ answerCount: number; answers: Answer[] }> {
  return request(`/api/assessments/${assessmentId}/answers`, { cache: 'no-store' });
}

export function getMappings(
  assessmentId: string,
): Promise<{ mappingCount: number; mappings: MappingEntry[] }> {
  return request(`/api/assessments/${assessmentId}/mappings`, { cache: 'no-store' });
}

export function getGrades(
  assessmentId: string,
): Promise<{ gradeCount: number; grades: GradeItem[]; summary: GradingSummary }> {
  return request(`/api/assessments/${assessmentId}/grades`, { cache: 'no-store' });
}

export function getReviews(
  assessmentId: string,
): Promise<{ reviewCount: number; reviews: ReviewItem[] }> {
  return request(`/api/assessments/${assessmentId}/reviews`, { cache: 'no-store' });
}

export type ReviewAction = 'accept' | 'reject' | 'skip';

export function submitReview(
  assessmentId: string,
  reviewId: string,
  action: ReviewAction,
  body: { reason?: string | null; reviewerId?: string | null } = {},
): Promise<unknown> {
  return request(`/api/assessments/${assessmentId}/reviews/${reviewId}/${action}`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
}

export function remapReview(
  assessmentId: string,
  reviewId: string,
  questionId: string,
  body: { reason?: string | null; reviewerId?: string | null } = {},
): Promise<unknown> {
  return request(`/api/assessments/${assessmentId}/reviews/${reviewId}/remap`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ ...body, questionId }),
  });
}

/** URL of a prepared page bitmap. The only place page images come from. */
export function pageImageUrl(
  assessmentId: string,
  documentId: string,
  pageNumber: number,
): string {
  return `/api/assessments/${assessmentId}/documents/${documentId}/pages/${pageNumber}`;
}
