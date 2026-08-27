import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { GET: questionsRoute } = await import(
  '@/app/api/assessments/[assessmentId]/questions/route'
);
const { POST: createRoute } = await import('@/app/api/assessments/route');
const { POST: uploadRoute } = await import(
  '@/app/api/assessments/[assessmentId]/documents/route'
);

const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { LocalDocumentStorage, setDocumentStorage } = await import('@/lib/storage/local-storage');
const { prepareAssessmentDocuments } = await import(
  '@/lib/services/document/document-preparation-service'
);
const { extractQuestions } = await import(
  '@/lib/services/question/question-extraction-service'
);
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { logger } = await import('@/lib/logger');
const { A4_PORTRAIT, asFile, makePdf } = await import('../fixtures/documents');

const store = new InMemoryAssessmentStore();
const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555';
let storageRoot: string;

function ctx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

async function seedPreparedAssessment(): Promise<string> {
  const created = await createRoute(
    new Request('http://localhost/api/assessments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'questions api' }),
    }),
  );
  const { assessmentId } = await created.json();

  const form = new FormData();
  form.set('type', 'QUESTION_PAPER');
  form.set('file', asFile(makePdf([A4_PORTRAIT, A4_PORTRAIT]), 'paper.pdf', 'application/pdf'));

  await uploadRoute(
    new Request('http://localhost/upload', { method: 'POST', body: form }),
    ctx(assessmentId),
  );

  await prepareAssessmentDocuments({ assessmentId, jobId: 'job-1', logger });
  return assessmentId as string;
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'veda-qapi-'));
  setDocumentStorage(new LocalDocumentStorage(storageRoot));
});

afterAll(async () => {
  setDocumentStorage(null);
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('GET /api/assessments/:assessmentId/questions', () => {
  it('returns an empty list before extraction has run', async () => {
    const assessmentId = await seedPreparedAssessment();
    const response = await questionsRoute(new Request('http://localhost'), ctx(assessmentId));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ assessmentId, questionCount: 0, questions: [] });
    expect(body.extraction).toBeNull();
  });

  it('returns extracted questions in deterministic order', async () => {
    const assessmentId = await seedPreparedAssessment();

    await extractQuestions({
      assessmentId,
      jobId: 'job-1',
      logger,
      provider: new FakeAIProvider({
        candidates: [
          {
            labelRaw: 'Q10',
            text: 'Explain xylem transport.',
            marks: 4,
            pageNumber: 2,
            rects: [{ pageNumber: 2, x: 0.1, y: 0.2, width: 0.7, height: 0.06 }],
          },
          {
            labelRaw: 'Q2',
            text: 'Which organelle performs photosynthesis?',
            marks: 2,
            pageNumber: 1,
            rects: [{ pageNumber: 1, x: 0.1, y: 0.4, width: 0.7, height: 0.05 }],
          },
        ],
      }),
    });

    const body = await (
      await questionsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.questionCount).toBe(2);
    // Returned by parsed label order, not the order the model produced.
    expect(body.questions.map((q: { labelRaw: string }) => q.labelRaw)).toEqual(['Q2', 'Q10']);
  });

  it('returns the documented question shape', async () => {
    const assessmentId = await seedPreparedAssessment();

    await extractQuestions({
      assessmentId,
      jobId: 'job-1',
      logger,
      provider: new FakeAIProvider({
        candidates: [
          {
            labelRaw: '11 (a)',
            text: 'Explain why plant B is pale.',
            marks: 5,
            pageNumber: 2,
            rects: [{ pageNumber: 2, x: 0.1, y: 0.3, width: 0.75, height: 0.12 }],
          },
        ],
      }),
    });

    const body = await (
      await questionsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.questions[0]).toMatchObject({
      labelRaw: '11 (a)',
      normalizedLabel: '11-a',
      parentLabel: '11',
      isSubQuestion: true,
      text: 'Explain why plant B is pale.',
      marks: 5,
      pageNumber: 2,
      pageNumbers: [2],
      rects: [{ pageNumber: 2, x: 0.1, y: 0.3, width: 0.75, height: 0.12 }],
    });
    expect(body.questions[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('exposes extraction metadata for debugging', async () => {
    const assessmentId = await seedPreparedAssessment();

    await extractQuestions({
      assessmentId,
      jobId: 'job-1',
      logger,
      provider: new FakeAIProvider({
        candidates: [
          {
            labelRaw: 'Q1',
            text: 'Define osmosis.',
            marks: null,
            pageNumber: 1,
            rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
          },
        ],
        usage: { promptTokens: 900, responseTokens: 120, totalTokens: 1020 },
      }),
    });

    const body = await (
      await questionsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.extraction).toMatchObject({
      provider: 'fake',
      model: 'fake-model-v1',
      promptVersion: 'question-extraction/v2',
      pagesProcessed: 2,
      questionsExtracted: 1,
      candidatesReceived: 1,
      candidatesRejected: 0,
    });
    expect(body.extraction.usage.totalTokens).toBe(1020);
  });

  it('never exposes prompts, page data or storage keys', async () => {
    const assessmentId = await seedPreparedAssessment();

    await extractQuestions({
      assessmentId,
      jobId: 'job-1',
      logger,
      provider: new FakeAIProvider({
        candidates: [
          {
            labelRaw: 'Q1',
            text: 'Define diffusion.',
            marks: 2,
            pageNumber: 1,
            rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
          },
        ],
      }),
    });

    const raw = JSON.stringify(
      await (await questionsRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('iVBOR');
    expect(raw).not.toContain('You are extracting questions');
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain(storageRoot);
    expect(raw).not.toContain('GEMINI_API_KEY');
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await questionsRoute(new Request('http://localhost'), ctx(UNKNOWN_ID));
    expect(response.status).toBe(404);
  });

  it('returns 400 for a malformed assessment id', async () => {
    const response = await questionsRoute(
      new Request('http://localhost'),
      ctx('../../etc/passwd'),
    );
    expect(response.status).toBe(400);
  });
});
