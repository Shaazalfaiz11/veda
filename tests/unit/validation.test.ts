import { describe, expect, it } from 'vitest';
import {
  AssessmentIdParamSchema,
  CreateAssessmentSchema,
  DocumentIdParamSchema,
  INVALID_JSON,
  PageParamSchema,
  UploadDocumentSchema,
  parseJsonBody,
} from '@/lib/validation';

describe('create assessment validation', () => {
  it('accepts an empty body', () => {
    expect(CreateAssessmentSchema.safeParse({}).success).toBe(true);
  });

  it('accepts a title', () => {
    const result = CreateAssessmentSchema.safeParse({ title: 'Unit test 3' });
    expect(result.success).toBe(true);
  });

  it('rejects an empty title', () => {
    expect(CreateAssessmentSchema.safeParse({ title: '' }).success).toBe(false);
  });

  it('rejects an over-long title', () => {
    expect(CreateAssessmentSchema.safeParse({ title: 'x'.repeat(201) }).success).toBe(false);
  });
});

describe('upload document validation', () => {
  it('accepts the two document types', () => {
    expect(UploadDocumentSchema.safeParse({ type: 'QUESTION_PAPER' }).success).toBe(true);
    expect(UploadDocumentSchema.safeParse({ type: 'ANSWER_SHEET' }).success).toBe(true);
  });

  it('rejects an unknown document type', () => {
    const result = UploadDocumentSchema.safeParse({ type: 'MARK_SCHEME' });
    expect(result.success).toBe(false);
    if (!result.success) expect(result.error.issues[0]?.message).toMatch(/must be one of/);
  });

  it('rejects a missing document type', () => {
    expect(UploadDocumentSchema.safeParse({ type: null }).success).toBe(false);
  });
});

describe('document param validation', () => {
  const ids = {
    assessmentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    documentId: '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d',
  };

  it('accepts a pair of UUIDs', () => {
    expect(DocumentIdParamSchema.safeParse(ids).success).toBe(true);
  });

  it('rejects a non-UUID document id', () => {
    expect(DocumentIdParamSchema.safeParse({ ...ids, documentId: '../secrets' }).success).toBe(
      false,
    );
  });

  it('coerces a 1-based page number from the path', () => {
    const result = PageParamSchema.safeParse({ ...ids, pageNumber: '3' });
    expect(result.success).toBe(true);
    if (result.success) expect(result.data.pageNumber).toBe(3);
  });

  it('rejects page number zero and negatives', () => {
    expect(PageParamSchema.safeParse({ ...ids, pageNumber: '0' }).success).toBe(false);
    expect(PageParamSchema.safeParse({ ...ids, pageNumber: '-2' }).success).toBe(false);
  });

  it('rejects a non-numeric page number', () => {
    expect(PageParamSchema.safeParse({ ...ids, pageNumber: 'abc' }).success).toBe(false);
  });
});

describe('assessment id param validation', () => {
  it('accepts a UUID', () => {
    const result = AssessmentIdParamSchema.safeParse({
      assessmentId: '3f2504e0-4f89-11d3-9a0c-0305e82c3301',
    });
    expect(result.success).toBe(true);
  });

  it('rejects a non-UUID path segment before it reaches the store', () => {
    const result = AssessmentIdParamSchema.safeParse({ assessmentId: 'not-a-uuid' });
    expect(result.success).toBe(false);
  });

  it('rejects a path traversal attempt', () => {
    const result = AssessmentIdParamSchema.safeParse({ assessmentId: '../../etc/passwd' });
    expect(result.success).toBe(false);
  });
});

describe('request body parsing', () => {
  it('treats an empty body as an empty object', async () => {
    const request = new Request('http://localhost/api/assessments', { method: 'POST', body: '' });
    await expect(parseJsonBody(request)).resolves.toEqual({});
  });

  it('flags malformed JSON rather than throwing', async () => {
    const request = new Request('http://localhost/api/assessments', {
      method: 'POST',
      body: '{ not json',
    });
    await expect(parseJsonBody(request)).resolves.toBe(INVALID_JSON);
  });

  it('returns the parsed object for valid JSON', async () => {
    const request = new Request('http://localhost/api/assessments', {
      method: 'POST',
      body: JSON.stringify({ title: 'ok' }),
    });
    await expect(parseJsonBody(request)).resolves.toEqual({ title: 'ok' });
  });
});
