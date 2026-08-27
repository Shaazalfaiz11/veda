import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { extractQuestions } = await import(
  '@/lib/services/question/question-extraction-service'
);
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
import type { ExtractedQuestionCandidate } from '@/lib/providers/ai';

const store = new InMemoryAssessmentStore();
let storageRoot: string;

function candidate(
  overrides: Partial<ExtractedQuestionCandidate> = {},
): ExtractedQuestionCandidate {
  return {
    labelRaw: 'Q1',
    text: 'Name the organelle responsible for photosynthesis.',
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.05 }],
    ...overrides,
  };
}

/** Seeds an assessment holding a question paper in the given state. */
async function seed(options: {
  pageCount?: number;
  status?: DocumentStatus;
  withPages?: boolean;
  includePaper?: boolean;
} = {}): Promise<string> {
  const {
    pageCount = 2,
    status = 'READY',
    withPages = true,
    includePaper = true,
  } = options;

  const assessment = await createAssessment({ title: 'extraction' });
  if (!includePaper) return assessment.id;

  const documentId = '9b1deb4d-3b7d-4bad-9bdd-2b0d7b3dcb6d';
  const storage = getDocumentStorage();
  const pages: PreparedPage[] = [];

  if (withPages) {
    for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
      const key = preparedPageKey(assessment.id, documentId, pageNumber);
      const bitmap = await makePng(60, 80);
      const stored = await storage.put(key, bitmap, { contentType: 'image/png' });

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
    type: 'QUESTION_PAPER',
    status,
    originalFilename: 'paper.pdf',
    format: 'PDF',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
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

// FakeAIProvider arrives as a value binding from a dynamic import, so the
// type has to be recovered from the constructor.
type Fake = InstanceType<typeof FakeAIProvider>;

function run(assessmentId: string, provider: Fake) {
  return extractQuestions({ assessmentId, jobId: 'job-1', logger, provider });
}

beforeAll(async () => {
  storageRoot = await mkdtemp(join(tmpdir(), 'veda-extract-'));
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
  it('persists validated questions against the assessment', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      candidates: [candidate({ labelRaw: 'Q1' }), candidate({ labelRaw: 'Q2' })],
    });

    const outcome = await run(assessmentId, provider);

    expect(outcome.questions).toHaveLength(2);
    expect(outcome.reused).toBe(false);

    const stored = await getAssessment(assessmentId);
    expect(stored.questions).toHaveLength(2);
    expect(stored.questions.map((q) => q.labelRaw)).toEqual(['Q1', 'Q2']);
  });

  it('sends every prepared page, in order, as base64', async () => {
    const assessmentId = await seed({ pageCount: 3 });
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    await run(assessmentId, provider);

    expect(provider.lastPages).toHaveLength(3);
    expect(provider.lastPages.map((page) => page.pageNumber)).toEqual([1, 2, 3]);
    expect(provider.lastPages[0]!.mimeType).toBe('image/png');
    // Base64 of a real PNG starts with the encoded signature.
    expect(provider.lastPages[0]!.data.startsWith('iVBOR')).toBe(true);
  });

  it('records extraction metadata for debugging', async () => {
    const assessmentId = await seed({ pageCount: 2 });
    const provider = new FakeAIProvider({
      candidates: [candidate({ labelRaw: 'Q1' }), candidate({ labelRaw: 'Q2', text: '' })],
      usage: { promptTokens: 1200, responseTokens: 300, totalTokens: 1500 },
    });

    const { metadata } = await run(assessmentId, provider);

    expect(metadata).toMatchObject({
      provider: 'fake',
      model: 'fake-model-v1',
      promptVersion: 'question-extraction/v2',
      pagesProcessed: 2,
      questionsExtracted: 1,
      candidatesReceived: 2,
      candidatesRejected: 1,
    });
    expect(metadata.usage).toEqual({
      promptTokens: 1200,
      responseTokens: 300,
      totalTokens: 1500,
    });
    expect(Date.parse(metadata.extractedAt)).not.toBeNaN();
  });

  it('stores no prompt text, page data or credentials alongside the questions', async () => {
    const assessmentId = await seed();
    await run(assessmentId, new FakeAIProvider({ candidates: [candidate()] }));

    const raw = JSON.stringify(await getAssessment(assessmentId));

    expect(raw).not.toContain('iVBOR');
    expect(raw).not.toContain('You are extracting questions');
    expect(raw).not.toContain('apiKey');
  });

  it('surfaces duplicate warnings in the metadata', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      candidates: [candidate({ labelRaw: 'Q2' }), candidate({ labelRaw: 'Q2' })],
    });

    const { metadata } = await run(assessmentId, provider);

    expect(metadata.warnings.some((w) => w.code === 'DUPLICATE_LABEL')).toBe(true);
  });

  it('accepts a paper with genuinely no questions', async () => {
    const assessmentId = await seed();
    const { questions, metadata } = await run(assessmentId, new FakeAIProvider({ candidates: [] }));

    expect(questions).toEqual([]);
    expect(metadata.candidatesReceived).toBe(0);
  });
});

describe('refusing to call the model', () => {
  it('will not extract when the question paper is still UPLOADED', async () => {
    const assessmentId = await seed({ status: 'UPLOADED' });
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ConflictError);
    expect(provider.extractQuestionsCalls).toBe(0);
  });

  it('will not extract when preparation failed', async () => {
    const assessmentId = await seed({ status: 'FAILED' });
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ConflictError);
    expect(provider.extractQuestionsCalls).toBe(0);
  });

  it('will not extract when the document has no prepared pages', async () => {
    const assessmentId = await seed({ withPages: false });
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ConflictError);
    expect(provider.extractQuestionsCalls).toBe(0);
  });

  it('will not extract when no question paper was uploaded', async () => {
    const assessmentId = await seed({ includePaper: false });
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    await expect(run(assessmentId, provider)).rejects.toThrow(ValidationError);
    expect(provider.extractQuestionsCalls).toBe(0);
  });
});

describe('provider failures', () => {
  it('propagates a transient failure so the queue can retry it', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      error: new DependencyUnavailableError('Gemini rate limit exceeded.'),
    });

    await expect(run(assessmentId, provider)).rejects.toMatchObject({
      code: 'DEPENDENCY_UNAVAILABLE',
      retryable: true,
    });

    // Nothing partial is persisted.
    const stored = await getAssessment(assessmentId);
    expect(stored.questions).toEqual([]);
    expect(stored.questionExtraction).toBeNull();
  });

  it('propagates a permanent failure without persisting anything', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      error: new ValidationError('Gemini returned structured output that failed validation.'),
    });

    await expect(run(assessmentId, provider)).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });

    expect((await getAssessment(assessmentId)).questions).toEqual([]);
  });

  it('fails when every candidate is rejected, rather than reporting success', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      candidates: [
        candidate({ labelRaw: '' }),
        candidate({ text: '' }),
        candidate({ rects: [] }),
      ],
    });

    await expect(run(assessmentId, provider)).rejects.toThrow(ValidationError);
    expect((await getAssessment(assessmentId)).questions).toEqual([]);
  });
});

describe('idempotency', () => {
  it('does not call the model twice when questions already exist', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    const first = await run(assessmentId, provider);
    const second = await run(assessmentId, provider);

    expect(provider.extractQuestionsCalls).toBe(1);
    expect(second.reused).toBe(true);
    expect(second.questions.map((q) => q.id)).toEqual(first.questions.map((q) => q.id));
  });

  it('produces no duplicate questions across repeated runs', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({
      candidates: [candidate({ labelRaw: 'Q1' }), candidate({ labelRaw: 'Q2' })],
    });

    await run(assessmentId, provider);
    await run(assessmentId, provider);
    await run(assessmentId, provider);

    const stored = await getAssessment(assessmentId);
    expect(stored.questions).toHaveLength(2);
    expect(new Set(stored.questions.map((q) => q.id)).size).toBe(2);
  });

  it('keeps the original extraction timestamp on reuse', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    const first = await run(assessmentId, provider);
    const second = await run(assessmentId, provider);

    expect(second.metadata.extractedAt).toBe(first.metadata.extractedAt);
  });
});

describe('Phase 3 boundary', () => {
  it('touches only question extraction on the provider', async () => {
    const assessmentId = await seed();
    const provider = new FakeAIProvider({ candidates: [candidate()] });

    const answers = vi.spyOn(provider, 'extractAnswers');
    const adjudicate = vi.spyOn(provider, 'adjudicateMapping');
    const grade = vi.spyOn(provider, 'gradeAnswer');

    await run(assessmentId, provider);

    expect(provider.extractQuestionsCalls).toBe(1);
    expect(answers).not.toHaveBeenCalled();
    expect(adjudicate).not.toHaveBeenCalled();
    expect(grade).not.toHaveBeenCalled();
  });

  it('persists no answer, mapping or grading state', async () => {
    const assessmentId = await seed();
    await run(assessmentId, new FakeAIProvider({ candidates: [candidate()] }));

    const stored = await getAssessment(assessmentId);

    // Question extraction writes questions and nothing else.
    expect(stored.answers).toEqual([]);
    expect(stored.mappings).toEqual([]);
    expect(stored.mapping).toBeNull();
    // Grading is a later stage; extraction leaves its fields untouched.
    expect(stored.grades).toEqual([]);
    expect(stored.grading).toBeNull();
    expect(stored.markSchemes).toBeNull();
  });
});
