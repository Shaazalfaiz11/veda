import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueAssessmentProcessing = vi.fn();

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: (...args: unknown[]) => enqueueAssessmentProcessing(...args),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { POST: createRoute } = await import('@/app/api/assessments/route');
const { POST: uploadRoute, GET: listRoute } = await import(
  '@/app/api/assessments/[assessmentId]/documents/route'
);
const { GET: documentRoute } = await import(
  '@/app/api/assessments/[assessmentId]/documents/[documentId]/route'
);
const { GET: pageRoute } = await import(
  '@/app/api/assessments/[assessmentId]/documents/[documentId]/pages/[pageNumber]/route'
);
const { POST: processRoute } = await import('@/app/api/assessments/[assessmentId]/process/route');
const { GET: statusRoute } = await import('@/app/api/assessments/[assessmentId]/status/route');

const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { LocalDocumentStorage, setDocumentStorage } = await import('@/lib/storage/local-storage');
const { prepareAssessmentDocuments } = await import(
  '@/lib/services/document/document-preparation-service'
);
const { logger } = await import('@/lib/logger');

const {
  A4_LANDSCAPE,
  A4_PORTRAIT,
  asFile,
  makeGarbage,
  makeJpeg,
  makeMalformedPdf,
  makePdf,
  makePng,
} = await import('../fixtures/documents');

const store = new InMemoryAssessmentStore();
const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555';

let storageRoot: string;

function ctx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

function docCtx(assessmentId: string, documentId: string) {
  return { params: Promise.resolve({ assessmentId, documentId }) };
}

function pageCtx(assessmentId: string, documentId: string, pageNumber: string) {
  return { params: Promise.resolve({ assessmentId, documentId, pageNumber }) };
}

async function createAssessmentViaApi(): Promise<string> {
  const response = await createRoute(
    new Request('http://localhost/api/assessments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'Phase 2' }),
    }),
  );
  return (await response.json()).assessmentId as string;
}

function uploadRequest(type: string, file: File | null): Request {
  const form = new FormData();
  form.set('type', type);
  if (file) form.set('file', file);

  return new Request('http://localhost/upload', { method: 'POST', body: form });
}

async function upload(assessmentId: string, type: string, file: File | null) {
  return uploadRoute(uploadRequest(type, file), ctx(assessmentId));
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'veda-docapi-'));
  setDocumentStorage(new LocalDocumentStorage(storageRoot));
});

afterAll(async () => {
  setDocumentStorage(null);
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
  enqueueAssessmentProcessing.mockReset();
  enqueueAssessmentProcessing.mockResolvedValue({ id: 'job' });
});

describe('POST /api/assessments/:assessmentId/documents', () => {
  it('accepts a question paper PDF and returns metadata, not bytes', async () => {
    const assessmentId = await createAssessmentViaApi();
    const pdf = makePdf([A4_PORTRAIT, A4_PORTRAIT]);

    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(pdf, 'Class_10_maths.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(201);

    const body = await response.json();
    expect(body).toMatchObject({
      assessmentId,
      type: 'QUESTION_PAPER',
      status: 'UPLOADED',
      format: 'PDF',
      mimeType: 'application/pdf',
      pageCount: null,
    });
    expect(body.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('accepts an answer sheet PDF', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'ANSWER_SHEET',
      asFile(makePdf([A4_PORTRAIT]), 'answers.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).type).toBe('ANSWER_SHEET');
  });

  it('accepts a PNG', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'ANSWER_SHEET',
      asFile(await makePng(600, 800), 'scan.png', 'image/png'),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).format).toBe('PNG');
  });

  it('accepts a JPEG', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'ANSWER_SHEET',
      asFile(await makeJpeg(600, 800), 'photo.jpg', 'image/jpeg'),
    );

    expect(response.status).toBe(201);
    expect((await response.json()).format).toBe('JPEG');
  });

  it('never returns a storage key or filesystem path', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), 'paper.pdf', 'application/pdf'),
    );

    const raw = JSON.stringify(await response.json());
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain(storageRoot);
    expect(raw).not.toContain('assessments/');
  });

  it('sanitises the original filename it echoes back', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), '../../etc/passwd.pdf', 'application/pdf'),
    );

    expect((await response.json()).originalFilename).toBe('passwd.pdf');
  });

  it('rejects an unsupported file type by content', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makeGarbage(512), 'lying.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(415);
    expect((await response.json()).error.code).toBe('UNSUPPORTED_DOCUMENT_TYPE');
  });

  it('rejects an empty file', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(Buffer.alloc(0), 'empty.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(422);
    expect((await response.json()).error.code).toBe('EMPTY_DOCUMENT');
  });

  it('rejects a file over the size ceiling', async () => {
    const assessmentId = await createAssessmentViaApi();
    // 11 MB against the 10 MB test ceiling.
    const oversized = Buffer.concat([makePdf([A4_PORTRAIT]), Buffer.alloc(11 * 1024 * 1024)]);

    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(oversized, 'huge.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(413);
    expect((await response.json()).error.code).toBe('DOCUMENT_TOO_LARGE');
  });

  it('rejects an unknown document type', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(
      assessmentId,
      'MARK_SCHEME',
      asFile(makePdf([A4_PORTRAIT]), 'x.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(400);
    expect((await response.json()).error.code).toBe('VALIDATION_ERROR');
  });

  it('rejects a request with no file field', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await upload(assessmentId, 'QUESTION_PAPER', null);

    expect(response.status).toBe(400);
  });

  it('rejects a non-multipart body', async () => {
    const assessmentId = await createAssessmentViaApi();
    const response = await uploadRoute(
      new Request('http://localhost/upload', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ type: 'QUESTION_PAPER' }),
      }),
      ctx(assessmentId),
    );

    expect(response.status).toBe(400);
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await upload(
      UNKNOWN_ID,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), 'p.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(404);
  });

  it('refuses an upload while the assessment is queued', async () => {
    const assessmentId = await createAssessmentViaApi();
    await processRoute(new Request('http://localhost'), ctx(assessmentId));

    const response = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), 'p.pdf', 'application/pdf'),
    );

    expect(response.status).toBe(409);
  });

  it('replaces an existing document of the same type', async () => {
    const assessmentId = await createAssessmentViaApi();

    const first = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), 'first.pdf', 'application/pdf'),
    );
    const second = await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_LANDSCAPE]), 'second.pdf', 'application/pdf'),
    );

    expect((await first.json()).id).not.toBe((await second.json()).id);

    const list = await (await listRoute(new Request('http://localhost'), ctx(assessmentId))).json();
    expect(list.documents).toHaveLength(1);
    expect(list.documents[0].originalFilename).toBe('second.pdf');
  });
});

describe('document retrieval', () => {
  async function preparedAssessment() {
    const assessmentId = await createAssessmentViaApi();

    const paper = await (
      await upload(
        assessmentId,
        'QUESTION_PAPER',
        asFile(makePdf([A4_PORTRAIT, A4_LANDSCAPE]), 'paper.pdf', 'application/pdf'),
      )
    ).json();

    await upload(
      assessmentId,
      'ANSWER_SHEET',
      asFile(await makePng(600, 900), 'answers.png', 'image/png'),
    );

    await prepareAssessmentDocuments({ assessmentId, jobId: 'job-1', logger });

    return { assessmentId, documentId: paper.id as string };
  }

  it('lists documents with prepared page geometry', async () => {
    const { assessmentId } = await preparedAssessment();
    const body = await (
      await listRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.documents).toHaveLength(2);

    const paper = body.documents.find((d: { type: string }) => d.type === 'QUESTION_PAPER');
    expect(paper.status).toBe('READY');
    expect(paper.pageCount).toBe(2);
    expect(paper.pages).toHaveLength(2);
    expect(paper.pages[0]).toMatchObject({ pageNumber: 1 });
  });

  it('returns one document with page numbers, dimensions and aspect ratios', async () => {
    const { assessmentId, documentId } = await preparedAssessment();
    const body = await (
      await documentRoute(new Request('http://localhost'), docCtx(assessmentId, documentId))
    ).json();

    expect(body.pages.map((p: { pageNumber: number }) => p.pageNumber)).toEqual([1, 2]);

    for (const page of body.pages) {
      expect(page.width).toBeGreaterThan(0);
      expect(page.height).toBeGreaterThan(0);
      expect(page.aspectRatio).toBeCloseTo(page.width / page.height, 4);
      expect(page.sourceWidth).toBeGreaterThan(0);
      expect(page.scale).toBeGreaterThan(0);
    }

    // Page 2 of the fixture is landscape; the geometry must reflect that.
    expect(body.pages[0].width).toBeLessThan(body.pages[0].height);
    expect(body.pages[1].width).toBeGreaterThan(body.pages[1].height);
  });

  it('addresses pages by number, never by storage path', async () => {
    const { assessmentId, documentId } = await preparedAssessment();
    const body = await (
      await documentRoute(new Request('http://localhost'), docCtx(assessmentId, documentId))
    ).json();

    expect(body.pages[0].url).toBe(
      `/api/assessments/${assessmentId}/documents/${documentId}/pages/1`,
    );
    expect(JSON.stringify(body)).not.toContain(storageRoot);
    expect(JSON.stringify(body)).not.toContain('storageKey');
  });

  it('returns 404 for an unknown document', async () => {
    const { assessmentId } = await preparedAssessment();
    const response = await documentRoute(
      new Request('http://localhost'),
      docCtx(assessmentId, UNKNOWN_ID),
    );

    expect(response.status).toBe(404);
  });

  it('returns 400 for a malformed document id', async () => {
    const { assessmentId } = await preparedAssessment();
    const response = await documentRoute(
      new Request('http://localhost'),
      docCtx(assessmentId, '../../secret'),
    );

    expect(response.status).toBe(400);
  });
});

describe('prepared page serving', () => {
  async function prepared() {
    const assessmentId = await createAssessmentViaApi();
    const document = await (
      await upload(
        assessmentId,
        'ANSWER_SHEET',
        asFile(makePdf([A4_PORTRAIT, A4_PORTRAIT]), 'answers.pdf', 'application/pdf'),
      )
    ).json();

    await prepareAssessmentDocuments({ assessmentId, jobId: 'job-1', logger });
    return { assessmentId, documentId: document.id as string };
  }

  it('streams the canonical page bitmap as a PNG', async () => {
    const { assessmentId, documentId } = await prepared();
    const response = await pageRoute(
      new Request('http://localhost'),
      pageCtx(assessmentId, documentId, '1'),
    );

    expect(response.status).toBe(200);
    expect(response.headers.get('content-type')).toBe('image/png');

    const bytes = Buffer.from(await response.arrayBuffer());
    expect(bytes.subarray(0, 8)).toEqual(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    );
  });

  it('reports the page dimensions the bitmap actually has', async () => {
    const { assessmentId, documentId } = await prepared();
    const response = await pageRoute(
      new Request('http://localhost'),
      pageCtx(assessmentId, documentId, '2'),
    );

    const width = Number(response.headers.get('x-page-width'));
    const height = Number(response.headers.get('x-page-height'));

    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(width);
  });

  it('returns 404 for a page beyond the document', async () => {
    const { assessmentId, documentId } = await prepared();
    const response = await pageRoute(
      new Request('http://localhost'),
      pageCtx(assessmentId, documentId, '99'),
    );

    expect(response.status).toBe(404);
  });

  it('rejects a non-numeric or zero page number', async () => {
    const { assessmentId, documentId } = await prepared();

    expect(
      (
        await pageRoute(
          new Request('http://localhost'),
          pageCtx(assessmentId, documentId, '0'),
        )
      ).status,
    ).toBe(400);

    expect(
      (
        await pageRoute(
          new Request('http://localhost'),
          pageCtx(assessmentId, documentId, '../../../etc/passwd'),
        )
      ).status,
    ).toBe(400);
  });
});

describe('status endpoint with documents', () => {
  it('reports per-document status alongside assessment status', async () => {
    const assessmentId = await createAssessmentViaApi();

    await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), 'paper.pdf', 'application/pdf'),
    );
    await upload(
      assessmentId,
      'ANSWER_SHEET',
      asFile(await makePng(400, 600), 'answers.png', 'image/png'),
    );

    const before = await (
      await statusRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(before.documents).toHaveLength(2);
    expect(before.documents.every((d: { status: string }) => d.status === 'UPLOADED')).toBe(true);
    expect(before.documents.every((d: { pageCount: null }) => d.pageCount === null)).toBe(true);

    await prepareAssessmentDocuments({ assessmentId, jobId: 'job-1', logger });

    const after = await (
      await statusRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(after.documents.every((d: { status: string }) => d.status === 'READY')).toBe(true);
    expect(
      after.documents.find((d: { type: string }) => d.type === 'ANSWER_SHEET').pageCount,
    ).toBe(1);
  });

  it('does not leak storage paths in the status payload', async () => {
    const assessmentId = await createAssessmentViaApi();
    await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makePdf([A4_PORTRAIT]), 'paper.pdf', 'application/pdf'),
    );

    const body = await (
      await statusRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    const raw = JSON.stringify(body);
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain(storageRoot);
  });

  it('records a failure against the document that could not be prepared', async () => {
    const assessmentId = await createAssessmentViaApi();
    await upload(
      assessmentId,
      'QUESTION_PAPER',
      asFile(makeMalformedPdf(), 'broken.pdf', 'application/pdf'),
    );

    await expect(
      prepareAssessmentDocuments({ assessmentId, jobId: 'job-1', logger }),
    ).rejects.toThrow();

    const body = await (
      await statusRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.documents[0].status).toBe('FAILED');
    // The assessment itself is untouched — document state is a separate concept.
    expect(body.status).toBe('CREATED');
  });
});
