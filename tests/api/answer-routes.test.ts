import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { GET: answersRoute } = await import(
  '@/app/api/assessments/[assessmentId]/answers/route'
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
const { extractAnswers } = await import('@/lib/services/answer/answer-extraction-service');
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { logger } = await import('@/lib/logger');
const { A4_PORTRAIT, asFile, makePdf } = await import('../fixtures/documents');

import type { ExtractedAnswerCandidate } from '@/lib/providers/ai';

const store = new InMemoryAssessmentStore();
const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555';
let storageRoot: string;

function ctx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

async function seedPreparedSheet(): Promise<string> {
  const created = await createRoute(
    new Request('http://localhost/api/assessments', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ title: 'answers api' }),
    }),
  );
  const { assessmentId } = await created.json();

  const form = new FormData();
  form.set('type', 'ANSWER_SHEET');
  form.set('file', asFile(makePdf([A4_PORTRAIT, A4_PORTRAIT]), 'answers.pdf', 'application/pdf'));

  await uploadRoute(
    new Request('http://localhost/upload', { method: 'POST', body: form }),
    ctx(assessmentId),
  );

  await prepareAssessmentDocuments({ assessmentId, jobId: 'job-1', logger });
  return assessmentId as string;
}

async function extract(assessmentId: string, answerCandidates: ExtractedAnswerCandidate[]) {
  await extractAnswers({
    assessmentId,
    jobId: 'job-1',
    logger,
    provider: new FakeAIProvider({
      answerCandidates,
      answerUsage: { promptTokens: 2000, responseTokens: 500, totalTokens: 2500 },
    }),
  });
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'veda-aapi-'));
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

describe('GET /api/assessments/:assessmentId/answers', () => {
  it('returns an empty list before extraction has run', async () => {
    const assessmentId = await seedPreparedSheet();
    const response = await answersRoute(new Request('http://localhost'), ctx(assessmentId));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ assessmentId, answerCount: 0, answers: [] });
    expect(body.extraction).toBeNull();
  });

  it('returns the documented answer shape', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q2',
        text: 'The process mainly occurs in the chloroplast of the plant cell.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.4, width: 0.75, height: 0.16, kind: 'text' }],
      },
    ]);

    const body = await (
      await answersRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.answerCount).toBe(1);
    expect(body.answers[0]).toMatchObject({
      claimedLabelRaw: 'Q2',
      claimedLabelNormalized: '2',
      text: 'The process mainly occurs in the chloroplast of the plant cell.',
      regions: [{ pageNumber: 1, x: 0.1, y: 0.4, width: 0.75, height: 0.16, kind: 'text' }],
      pageNumbers: [1],
      spansPages: false,
      containsDiagram: false,
      documentPosition: 0,
    });
    expect(body.answers[0].id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('never returns a question reference', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q1',
        text: 'The chloroplast.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.05, kind: 'text' }],
      },
    ]);

    const raw = JSON.stringify(
      await (await answersRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('questionId');
    expect(raw).not.toContain('parentQuestionId');
    expect(raw).not.toContain('confidence');
  });

  it('returns answers in reading order', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q3',
        text: 'Third on the sheet.',
        regions: [{ pageNumber: 2, x: 0.1, y: 0.2, width: 0.5, height: 0.05, kind: 'text' }],
      },
      {
        claimedLabelRaw: 'Q1',
        text: 'First on the sheet.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05, kind: 'text' }],
      },
      {
        claimedLabelRaw: 'Q2',
        text: 'Second on the sheet.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.6, width: 0.5, height: 0.05, kind: 'text' }],
      },
    ]);

    const body = await (
      await answersRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.answers.map((a: { text: string }) => a.text)).toEqual([
      'First on the sheet.',
      'Second on the sheet.',
      'Third on the sheet.',
    ]);
    expect(body.answers.map((a: { documentPosition: number }) => a.documentPosition)).toEqual([
      0, 1, 2,
    ]);
  });

  it('returns a multi-page answer with regions on both pages', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q4',
        text: 'First half of the answer. Continued on the next page.',
        regions: [
          { pageNumber: 1, x: 0.1, y: 0.75, width: 0.8, height: 0.2, kind: 'text' },
          { pageNumber: 2, x: 0.1, y: 0.05, width: 0.8, height: 0.25, kind: 'text' },
        ],
      },
    ]);

    const body = await (
      await answersRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.answers).toHaveLength(1);
    expect(body.answers[0].regions).toHaveLength(2);
    expect(body.answers[0].pageNumbers).toEqual([1, 2]);
    expect(body.answers[0].spansPages).toBe(true);
  });

  it('returns an unlabelled answer', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: null,
        text: 'The process occurs in the chloroplast.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.3, width: 0.7, height: 0.1, kind: 'text' }],
      },
    ]);

    const body = await (
      await answersRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.answers[0].claimedLabelRaw).toBeNull();
    expect(body.answers[0].claimedLabelNormalized).toBeNull();
    expect(body.extraction.unlabelledCount).toBe(1);
  });

  it('marks an answer containing a diagram', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q5',
        text: 'Sunlight enters the leaf. [diagram: plant with labelled arrows]',
        regions: [
          { pageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.06, kind: 'text' },
          { pageNumber: 1, x: 0.2, y: 0.3, width: 0.5, height: 0.25, kind: 'diagram' },
        ],
      },
    ]);

    const body = await (
      await answersRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.answers[0].containsDiagram).toBe(true);
    expect(body.answers[0].regions.map((r: { kind: string }) => r.kind)).toEqual([
      'text',
      'diagram',
    ]);
  });

  it('exposes extraction metadata and warnings', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q2',
        text: 'First attempt.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05, kind: 'text' }],
      },
      {
        claimedLabelRaw: 'Q2',
        text: 'Second attempt.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.5, width: 0.5, height: 0.05, kind: 'text' }],
      },
    ]);

    const body = await (
      await answersRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.extraction).toMatchObject({
      provider: 'fake',
      model: 'fake-model-v1',
      promptVersion: 'answer-extraction/v3',
      pagesProcessed: 2,
      answersExtracted: 2,
    });
    expect(body.extraction.usage.totalTokens).toBe(2500);
    expect(
      body.extraction.warnings.some(
        (w: { code: string }) => w.code === 'DUPLICATE_CLAIMED_LABEL',
      ),
    ).toBe(true);
  });

  it('never exposes prompts, page data or storage keys', async () => {
    const assessmentId = await seedPreparedSheet();

    await extract(assessmentId, [
      {
        claimedLabelRaw: 'Q1',
        text: 'Some working.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05, kind: 'text' }],
      },
    ]);

    const raw = JSON.stringify(
      await (await answersRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('iVBOR');
    expect(raw).not.toContain('You are reading a student');
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain(storageRoot);
    expect(raw).not.toContain('GEMINI_API_KEY');
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await answersRoute(new Request('http://localhost'), ctx(UNKNOWN_ID));
    expect(response.status).toBe(404);
  });

  it('returns 400 for a malformed assessment id', async () => {
    const response = await answersRoute(
      new Request('http://localhost'),
      ctx('../../etc/passwd'),
    );
    expect(response.status).toBe(400);
  });
});
