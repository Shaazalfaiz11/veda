import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { GET: mappingsRoute } = await import(
  '@/app/api/assessments/[assessmentId]/mappings/route'
);
const { mapAnswersToQuestions } = await import('@/lib/services/mapping/mapping-service');
const { createAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { FakeEmbeddingProvider } = await import('@/lib/providers/embeddings');
const { logger } = await import('@/lib/logger');
const { parseQuestionLabel } = await import('@/lib/domain/question');
const { resetEnvCache } = await import('@/lib/config');

import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';

const store = new InMemoryAssessmentStore();
const UNKNOWN_ID = '11111111-2222-3333-4444-555555555555';

function ctx(assessmentId: string) {
  return { params: Promise.resolve({ assessmentId }) };
}

function question(id: string, labelRaw: string, text: string): Question {
  const parsed = parseQuestionLabel(labelRaw);

  return {
    id,
    labelRaw,
    normalizedLabel: parsed.normalizedLabel,
    sortKey: parsed.sortKey,
    parentLabel: parsed.parentLabel,
    isSubQuestion: parsed.isSubQuestion,
    text,
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
  };
}

function answer(id: string, claimedLabelRaw: string | null, text: string): Answer {
  return {
    id,
    claimedLabelRaw,
    claimedLabelNormalized: claimedLabelRaw
      ? parseQuestionLabel(claimedLabelRaw).normalizedLabel
      : null,
    text,
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.05, kind: 'text' }],
    pageNumbers: [1],
    spansPages: false,
    hasUncertainSegments: false,
    containsDiagram: false,
    documentPosition: 0,
  };
}

const Q1 = question('q-1', 'Q1', 'Which organelle is primarily involved in photosynthesis?');
const Q2 = question('q-2', 'Q2', 'Describe the flow of blood through the human heart.');
const Q3 = question('q-3', 'Q3', 'Define osmosis and give one example.');

const A1_TEXT = 'The chloroplast is the organelle responsible.';

function embeddings() {
  return new FakeEmbeddingProvider({
    dimensions: 4,
    vectors: {
      [Q1.text]: [1, 0, 0, 0.1],
      [A1_TEXT]: [0.97, 0.05, 0, 0.1],
      [Q2.text]: [0, 1, 0, 0.1],
      [Q3.text]: [0, 0, 1, 0.1],
    },
  });
}

async function seedAndMap(): Promise<string> {
  const assessment = await createAssessment({ title: 'mappings api' });

  await store.update(assessment.id, (current) => ({
    ...current,
    questions: [Q1, Q2, Q3],
    answers: [answer('a-1', 'Q1', A1_TEXT)],
  }));

  await mapAnswersToQuestions({
    assessmentId: assessment.id,
    jobId: 'job-1',
    logger,
    provider: new FakeAIProvider(),
    embeddings: embeddings(),
  });

  return assessment.id;
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('GET /api/assessments/:assessmentId/mappings', () => {
  it('returns an empty list before mapping has run', async () => {
    const assessment = await createAssessment({ title: 'not mapped' });
    const response = await mappingsRoute(new Request('http://localhost'), ctx(assessment.id));

    expect(response.status).toBe(200);

    const body = await response.json();
    expect(body).toMatchObject({ assessmentId: assessment.id, mappingCount: 0, mappings: [] });
    expect(body.mapping).toBeNull();
  });

  it('returns the documented mapping shape', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.mappingCount).toBe(1);
    expect(body.mappings[0]).toMatchObject({
      answerId: 'a-1',
      aiMapping: {
        questionId: 'q-1',
        status: expect.any(String),
        confidence: expect.any(Number),
        confidenceBand: expect.any(String),
      },
      effectiveMapping: { questionId: 'q-1', source: 'AI' },
    });
  });

  it('returns the candidates that lost, not only the winner', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    const candidates = body.mappings[0].aiMapping.candidates;

    expect(candidates.length).toBeGreaterThan(1);
    expect(candidates.some((c: { questionId: string }) => c.questionId !== 'q-1')).toBe(true);
  });

  it('returns every signal behind each candidate', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    for (const candidate of body.mappings[0].aiMapping.candidates) {
      expect(candidate.signals).toMatchObject({
        label: expect.any(Number),
        labelKind: expect.any(String),
        semantic: expect.any(Number),
        position: expect.any(Number),
        structure: expect.any(Number),
      });
      expect(candidate).toHaveProperty('candidateScore');
      expect(candidate).toHaveProperty('finalConfidence');
    }
  });

  it('returns reason codes, so a confidence is never unexplained', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(Array.isArray(body.mappings[0].aiMapping.reasonCodes)).toBe(true);
    expect(body.mappings[0].aiMapping.reasonCodes).toContain('DIRECT_LABEL_MATCH');
  });

  it('returns what the adjudicator said, separately from our own score', async () => {
    /*
     * This is about what the route reports once an adjudication exists, not
     * about when one is sought. The shared fixture is decisive enough that the
     * mapping stage now answers it without a call, so the margin floor is
     * raised to require one -- the documented way to say "consult on
     * everything".
     */
    process.env.MAPPING_DECISIVE_MARGIN_MIN = '1';
    resetEnvCache();

    let assessmentId: string;
    try {
      assessmentId = await seedAndMap();
    } finally {
      delete process.env.MAPPING_DECISIVE_MARGIN_MIN;
      resetEnvCache();
    }

    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.mappings[0].aiMapping.verification).toMatchObject({
      decision: 'MATCH',
      provider: 'fake',
      promptVersion: 'mapping-adjudication/v1',
      modelConfidence: expect.any(Number),
    });
    // The application's confidence is its own number.
    expect(body.mappings[0].aiMapping.confidence).not.toBe(
      body.mappings[0].aiMapping.verification.modelConfidence,
    );
  });

  it('reports questions no answer reached', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.unmappedQuestionIds).toContain('q-2');
    expect(body.unmappedQuestionIds).toContain('q-3');
  });

  it('summarises what needs review', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.summary).toMatchObject({
      autoMapped: expect.any(Number),
      reviewRequired: expect.any(Number),
      humanReview: expect.any(Number),
      unmapped: expect.any(Number),
    });

    const total =
      body.summary.autoMapped +
      body.summary.reviewRequired +
      body.summary.humanReview +
      body.summary.unmapped;
    expect(total).toBe(body.mappingCount);
  });

  it('returns the weights and thresholds the run used', async () => {
    const assessmentId = await seedAndMap();
    const body = await (
      await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))
    ).json();

    expect(body.mapping.weights.label).toBeGreaterThan(0);
    expect(body.mapping.thresholds).toMatchObject({ high: 0.9, medium: 0.7 });
    expect(body.mapping.topK).toBe(3);
  });

  it('exposes no credentials, prompts or storage paths', async () => {
    const assessmentId = await seedAndMap();
    const raw = JSON.stringify(
      await (await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('GEMINI_API_KEY');
    expect(raw).not.toContain('apiKey');
    expect(raw).not.toContain('storageKey');
    expect(raw).not.toContain('You are');
  });

  it('exposes no grading', async () => {
    const assessmentId = await seedAndMap();
    const raw = JSON.stringify(
      await (await mappingsRoute(new Request('http://localhost'), ctx(assessmentId))).json(),
    );

    expect(raw).not.toContain('awarded');
    expect(raw).not.toContain('feedback');
  });

  it('returns 404 for an unknown assessment', async () => {
    const response = await mappingsRoute(new Request('http://localhost'), ctx(UNKNOWN_ID));
    expect(response.status).toBe(404);
  });

  it('returns 400 for a malformed assessment id', async () => {
    const response = await mappingsRoute(
      new Request('http://localhost'),
      ctx('../../etc/passwd'),
    );
    expect(response.status).toBe(400);
  });
});
