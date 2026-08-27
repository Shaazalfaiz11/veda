import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { extractAnswers } = await import('@/lib/services/answer/answer-extraction-service');
const { createAssessment, getAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { LocalDocumentStorage, setDocumentStorage } = await import('@/lib/storage/local-storage');
const { getDocumentStorage, preparedPageKey } = await import('@/lib/storage');
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { ConflictError, DependencyUnavailableError, ValidationError } = await import(
  '@/lib/errors'
);
const { logger } = await import('@/lib/logger');
const { makePng } = await import('../fixtures/documents');

import type { AssessmentDocument, DocumentStatus, PreparedPage } from '@/lib/domain/document';
import type { ExtractedAnswerCandidate } from '@/lib/providers/ai';

const store = new InMemoryAssessmentStore();
let storageRoot: string;

type Fake = InstanceType<typeof FakeAIProvider>;

function candidate(
  overrides: Partial<ExtractedAnswerCandidate> = {},
): ExtractedAnswerCandidate {
  return {
    claimedLabelRaw: 'Q1',
    text: 'Photosynthesis occurs in the chloroplast.',
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.08, kind: 'text' }],
    ...overrides,
  };
}

/** Seeds an assessment holding an answer sheet in the given state. */
async function seed(
  options: {
    pageCount?: number;
    status?: DocumentStatus;
    withPages?: boolean;
    includeSheet?: boolean;
  } = {},
): Promise<string> {
  const { pageCount = 2, status = 'READY', withPages = true, includeSheet = true } = options;

  const assessment = await createAssessment({ title: 'answer extraction' });
  if (!includeSheet) return assessment.id;

  const documentId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const storage = getDocumentStorage();
  const pages: PreparedPage[] = [];

  if (withPages) {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const key = preparedPageKey(assessment.id, documentId, pageNumber);
      const stored = await storage.put(key, await makePng(60, 80), {
        contentType: 'image/png',
      });

      pages.push({
        documentId,
        pageNumber,
        width: 60,
        height: 80,
        aspectRatio: 0.75,
        sourceWidth: 595,
        sourceHeight: 842,
        scale: 0.1,
        rotation: 0,
        storageKey: key,
        mimeType: 'image/png',
        sizeBytes: stored.sizeBytes,
      });
    }
  }

  const document: AssessmentDocument = {
    id: documentId,
    assessmentId: assessment.id,
    type: 'ANSWER_SHEET',
    status,
    originalFilename: 'answers.pdf',
    format: 'PDF',
    mimeType: 'application/pdf',
    sizeBytes: 2048,
    pageCount: withPages ? pageCount : null,
    pages,
    storageKey: `assessments/${assessment.id}/${documentId}/original`,
    failure: null,
    uploadedAt: new Date().toISOString(),
    preparedAt: status === 'READY' ? new Date().toISOString() : null,
  };

  await store.update(assessment.id, (current) => ({ ...current, documents: [document] }));
  return assessment.id;
}

function run(assessmentId: string, provider: Fake) {
  return extractAnswers({ assessmentId, jobId: 'job-1', logger, provider });
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'veda-answers-'));
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

describe('successful extraction', () => {
  it('persists validated answers against the assessment', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      answerCandidates: [
        candidate({ claimedLabelRaw: 'Q1' }),
        candidate({
          claimedLabelRaw: 'Q2',
          regions: [{ pageNumber: 1, x: 0.1, y: 0.5, width: 0.7, height: 0.08, kind: 'text' }],
        }),
      ],
    });

    const outcome = await run(assessmentId, provider);

    expect(outcome.answers).toHaveLength(2);
    expect(outcome.reused).toBe(false);

    const stored = await getAssessment(assessmentId);
    expect(stored.answers).toHaveLength(2);
    expect(stored.answers.map((a) => a.claimedLabelRaw)).toEqual(['Q1', 'Q2']);
  });

  it('sends every prepared page, in order, as base64', async () => {
    const assessmentId = await seed({ pageCount: 3 });
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    await run(assessmentId, provider);

    expect(provider.lastAnswerPages).toHaveLength(3);
    expect(provider.lastAnswerPages.map((p) => p.pageNumber)).toEqual([1, 2, 3]);
    expect(provider.lastAnswerPages[0]!.data.startsWith('iVBOR')).toBe(true);
  });

  it('sends all pages in one call so a spanning answer can be seen whole', async () => {
    const assessmentId = await seed({ pageCount: 3 });
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    await run(assessmentId, provider);

    // One call, three pages — not one call per page.
    expect(provider.extractAnswersCalls).toBe(1);
    expect(provider.lastAnswerPages).toHaveLength(3);
  });

  it('records extraction metadata for debugging', async () => {
    const assessmentId = await seed({ pageCount: 2 });
    const provider = new FakeAIProvider({
      answerCandidates: [
        candidate({ claimedLabelRaw: 'Q1' }),
        candidate({ claimedLabelRaw: null, text: '' }),
      ],
      answerUsage: { promptTokens: 2400, responseTokens: 800, totalTokens: 3200 },
    });

    const { metadata } = await run(assessmentId, provider);

    expect(metadata).toMatchObject({
      provider: 'fake',
      model: 'fake-model-v1',
      promptVersion: 'answer-extraction/v3',
      pagesProcessed: 2,
      answersExtracted: 1,
      candidatesReceived: 2,
      candidatesRejected: 1,
    });
    expect(metadata.usage?.totalTokens).toBe(3200);
    expect(Date.parse(metadata.extractedAt)).not.toBeNaN();
  });

  it('counts unlabelled answers in the metadata', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      answerCandidates: [
        candidate({ claimedLabelRaw: 'Q1' }),
        candidate({
          claimedLabelRaw: null,
          regions: [{ pageNumber: 1, x: 0.1, y: 0.5, width: 0.7, height: 0.08, kind: 'text' }],
        }),
      ],
    });

    const { metadata } = await run(assessmentId, provider);
    expect(metadata.unlabelledCount).toBe(1);
  });

  it('stores no prompt text, page data or credentials alongside the answers', async () => {
    const assessmentId = await seed();
    await run(assessmentId, new FakeAIProvider({ answerCandidates: [candidate()] }));

    const raw = JSON.stringify(await getAssessment(assessmentId));

    expect(raw).not.toContain('iVBOR');
    expect(raw).not.toContain('You are reading a student');
    expect(raw).not.toContain('apiKey');
  });

  it('accepts a genuinely blank answer sheet', async () => {
    const assessmentId = await seed();
    const { answers, metadata } = await run(
      assessmentId,
      new FakeAIProvider({ answerCandidates: [] }),
    );

    expect(answers).toEqual([]);
    expect(metadata.candidatesReceived).toBe(0);
  });
});

describe('refusing to call the model', () => {
  it('will not extract when the answer sheet is still UPLOADED', async () => {
    const assessmentId = await seed({ status: 'UPLOADED' });
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ConflictError);
    expect(provider.extractAnswersCalls).toBe(0);
  });

  it('will not extract when preparation failed', async () => {
    const assessmentId = await seed({ status: 'FAILED' });
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ConflictError);
    expect(provider.extractAnswersCalls).toBe(0);
  });

  it('will not extract when the sheet has no prepared pages', async () => {
    const assessmentId = await seed({ withPages: false });
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ConflictError);
    expect(provider.extractAnswersCalls).toBe(0);
  });

  it('will not extract when no answer sheet was uploaded', async () => {
    const assessmentId = await seed({ includeSheet: false });
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ValidationError);
    expect(provider.extractAnswersCalls).toBe(0);
  });
});

describe('provider failures', () => {
  it('propagates a transient failure so the queue can retry it', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      answerError: new DependencyUnavailableError('Gemini rate limit exceeded.'),
    });

    await expect(run(assessmentId, provider)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });

    const stored = await getAssessment(assessmentId);
    expect(stored.answers).toEqual([]);
    expect(stored.answerExtraction).toBeNull();
  });

  it('propagates a permanent failure without persisting anything', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      answerError: new ValidationError('Gemini returned output that failed validation.'),
    });

    await expect(run(assessmentId, provider)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });

    expect((await getAssessment(assessmentId)).answers).toEqual([]);
  });

  it('fails when every candidate is rejected, rather than reporting success', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      answerCandidates: [
        candidate({ text: '' }),
        candidate({ regions: [] }),
        candidate({
          regions: [{ pageNumber: 99, x: 0.1, y: 0.1, width: 0.5, height: 0.1, kind: 'text' }],
        }),
      ],
    });

    await expect(run(assessmentId, provider)).rejects.toThrow(ValidationError);
    expect((await getAssessment(assessmentId)).answers).toEqual([]);
  });
});

describe('idempotency', () => {
  it('does not call the model twice when answers already exist', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    const first = await run(assessmentId, provider);
    const second = await run(assessmentId, provider);

    expect(provider.extractAnswersCalls).toBe(1);
    expect(second.reused).toBe(true);
    expect(second.answers.map((a) => a.id)).toEqual(first.answers.map((a) => a.id));
  });

  it('produces no duplicate answers across repeated runs', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      answerCandidates: [
        candidate({ claimedLabelRaw: 'Q1' }),
        candidate({
          claimedLabelRaw: 'Q2',
          regions: [{ pageNumber: 1, x: 0.1, y: 0.5, width: 0.7, height: 0.08, kind: 'text' }],
        }),
      ],
    });

    await run(assessmentId, provider);
    await run(assessmentId, provider);
    await run(assessmentId, provider);

    const stored = await getAssessment(assessmentId);
    expect(stored.answers).toHaveLength(2);
    expect(new Set(stored.answers.map((a) => a.id)).size).toBe(2);
  });

  it('keeps the original extraction timestamp on reuse', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    const first = await run(assessmentId, provider);
    const second = await run(assessmentId, provider);

    expect(second.metadata.extractedAt).toBe(first.metadata.extractedAt);
  });
});

describe('Phase 4 boundary', () => {
  it('never reads the extracted questions', async () => {
    const assessmentId = await seed();

    // Seed questions the service must not consult.
    await store.update(assessmentId, (current) => ({
      ...current,
      questions: [
        {
          id: 'question-1',
          labelRaw: 'Q1',
          normalizedLabel: '1',
          sortKey: { major: 1, minor: null, roman: null },
          parentLabel: null,
          isSubQuestion: false,
          text: 'Which organelle performs photosynthesis?',
          marks: 2,
          pageNumber: 1,
          rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
          pageNumbers: [1],
        },
      ],
    }));

    const { answers } = await run(
      assessmentId,
      new FakeAIProvider({ answerCandidates: [candidate({ claimedLabelRaw: 'Q1' })] }),
    );

    // Even with an exact label match available, no link is made.
    const answer = answers[0]! as unknown as Record<string, unknown>;
    expect(answer['questionId']).toBeUndefined();
    expect(JSON.stringify(answers)).not.toContain('question-1');
  });

  it('touches only answer extraction on the provider', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });

    const questions = vi.spyOn(provider, 'extractQuestions');
    const adjudicate = vi.spyOn(provider, 'adjudicateMapping');
    const grade = vi.spyOn(provider, 'gradeAnswer');

    await run(assessmentId, provider);

    expect(provider.extractAnswersCalls).toBe(1);
    expect(questions).not.toHaveBeenCalled();
    expect(adjudicate).not.toHaveBeenCalled();
    expect(grade).not.toHaveBeenCalled();
  });

  it('persists no mapping or grading state', async () => {
    const assessmentId = await seed();
    await run(assessmentId, new FakeAIProvider({ answerCandidates: [candidate()] }));

    const stored = await getAssessment(assessmentId);

    // Answer extraction writes answers and nothing else — no mapping is made
    // even though questions and answers now both exist.
    expect(stored.mappings).toEqual([]);
    expect(stored.mapping).toBeNull();
    // Grading is a later stage; extraction leaves its fields untouched.
    expect(stored.grades).toEqual([]);
    expect(stored.grading).toBeNull();
    expect(stored.markSchemes).toBeNull();
  });
});
