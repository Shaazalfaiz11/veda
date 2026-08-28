import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { mapAnswersToQuestions } = await import('@/lib/services/mapping/mapping-service');
const { createAssessment, getAssessment } = await import('@/lib/services/assessment-service');
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { FakeAIProvider } = await import('@/lib/providers/ai');
const { FakeEmbeddingProvider } = await import('@/lib/providers/embeddings');
const { ConflictError, DependencyUnavailableError, ValidationError } = await import(
  '@/lib/errors'
);
const { logger } = await import('@/lib/logger');
const { resetEnvCache } = await import('@/lib/config');
const { parseQuestionLabel } = await import('@/lib/domain/question');

import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';
import type { MappingAdjudicationRequest } from '@/lib/providers/ai';

const store = new InMemoryAssessmentStore();

type Fake = InstanceType<typeof FakeAIProvider>;
type FakeEmbeddings = InstanceType<typeof FakeEmbeddingProvider>;

function question(id: string, labelRaw: string, text: string, marks: number | null = 2): Question {
  const parsed = parseQuestionLabel(labelRaw);

  return {
    id,
    labelRaw,
    normalizedLabel: parsed.normalizedLabel,
    sortKey: parsed.sortKey,
    parentLabel: parsed.parentLabel,
    isSubQuestion: parsed.isSubQuestion,
    text,
    marks,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
  };
}

function answer(id: string, claimedLabelRaw: string | null, text: string): Answer {
  const normalized = claimedLabelRaw
    ? parseQuestionLabel(claimedLabelRaw).normalizedLabel
    : null;

  return {
    id,
    claimedLabelRaw,
    claimedLabelNormalized: normalized,
    text,
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.05, kind: 'text' }],
    pageNumbers: [1],
    spansPages: false,
    hasUncertainSegments: false,
    containsDiagram: false,
    documentPosition: 0,
  };
}

async function seed(questions: Question[], answers: Answer[]): Promise<string> {
  const assessment = await createAssessment({ title: 'mapping' });

  await store.update(assessment.id, (current) => ({
    ...current,
    questions,
    answers: answers.map((entry, index) => ({ ...entry, documentPosition: index })),
  }));

  return assessment.id;
}

function run(assessmentId: string, provider: Fake, embeddings: FakeEmbeddings) {
  return mapAnswersToQuestions({
    assessmentId,
    jobId: 'job-1',
    logger,
    provider,
    embeddings,
  });
}

const PHOTOSYNTHESIS = question(
  'q-1',
  'Q1',
  'Which organelle is primarily involved in photosynthesis?',
);
const HEART = question('q-2', 'Q2', 'Describe the flow of blood through the human heart.');
const OSMOSIS = question('q-3', 'Q3', 'Define osmosis and give one example.');

const CHLOROPLAST_ANSWER = 'The chloroplast is the organelle responsible.';
const HEART_ANSWER =
  'Blood enters the right atrium and passes into the right ventricle of the heart.';

/**
 * Scripted vectors.
 *
 * A bag-of-words fake cannot know that "chloroplast" answers a question about
 * "photosynthesis" — they share no words. Where a test depends on semantic
 * discrimination, the vectors say so explicitly, which is both honest about
 * what is being tested and deterministic.
 */
function semanticEmbeddings(): FakeEmbeddings {
  return new FakeEmbeddingProvider({
    dimensions: 4,
    vectors: {
      [PHOTOSYNTHESIS.text]: [1, 0, 0, 0.1],
      [CHLOROPLAST_ANSWER]: [0.97, 0.05, 0, 0.1],
      [HEART.text]: [0, 1, 0, 0.1],
      [HEART_ANSWER]: [0.05, 0.97, 0, 0.1],
      [OSMOSIS.text]: [0, 0, 1, 0.1],
    },
  });
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('candidate generation', () => {
  it('auto-maps when label, semantics and the adjudicator all agree', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', CHLOROPLAST_ANSWER)],
    );

    const { mappings } = await run(assessmentId, new FakeAIProvider(), semanticEmbeddings());

    expect(mappings[0]!.questionId).toBe('q-1');
    expect(mappings[0]!.confidence).toBeGreaterThanOrEqual(0.9);
    expect(mappings[0]!.status).toBe('AUTO_MAPPED');
    expect(mappings[0]!.reasonCodes).toContain('DIRECT_LABEL_MATCH');
    expect(mappings[0]!.reasonCodes).toContain('LABEL_AND_SEMANTIC_AGREE');
  });

  it('asks for review when the label matches but the content does not', async () => {
    // The student wrote "Q1" above an answer about the heart. That is worth a
    // human glance, not a silent auto-map.
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', HEART_ANSWER)],
    );

    const { mappings } = await run(assessmentId, new FakeAIProvider(), semanticEmbeddings());

    expect(mappings[0]!.status).not.toBe('AUTO_MAPPED');
  });

  it('keeps only the top K candidates', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART, OSMOSIS, question('q-4', 'Q4', 'Explain diffusion.')],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    // Four questions, three candidates.
    expect(mappings[0]!.candidates).toHaveLength(3);
  });

  it('records every signal on every candidate', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    for (const candidate of mappings[0]!.candidates) {
      expect(candidate.signals).toMatchObject({
        label: expect.any(Number),
        labelKind: expect.any(String),
        semantic: expect.any(Number),
        semanticCosine: expect.any(Number),
        position: expect.any(Number),
        structure: expect.any(Number),
      });
      expect(candidate.candidateScore).toBeGreaterThanOrEqual(0);
    }
  });

  it('keeps the losing candidates so a mapping can be reviewed', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART, OSMOSIS],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    expect(mappings[0]!.candidates.length).toBeGreaterThan(1);
    expect(mappings[0]!.candidates.some((c) => c.questionId !== 'q-1')).toBe(true);
  });

  it('maps an unlabelled answer on semantics alone', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', null, HEART_ANSWER)],
    );

    const { mappings } = await run(assessmentId, new FakeAIProvider(), semanticEmbeddings());

    expect(mappings[0]!.questionId).toBe('q-2');
    expect(mappings[0]!.signals?.labelKind).toBe('NO_LABEL');
    expect(mappings[0]!.reasonCodes).toContain('SEMANTIC_MATCH');
  });

  it('scores a bare "(a)" equally against every sub-part', async () => {
    const sixA = question('q-6a', '6(a)', 'Explain why plant B is pale.');
    const elevenA = question('q-11a', '11(a)', 'State one use of a lever.');

    const assessmentId = await seed(
      [sixA, elevenA],
      [answer('a-1', '(a)', 'Because it received less light.')],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    const labels = mappings[0]!.candidates.map((c) => c.signals.label);
    expect(new Set(labels).size).toBe(1);
    expect(mappings[0]!.candidates[0]!.signals.labelKind).toBe('SUBPART_ONLY');
  });

  it('penalises a contradicted label', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q2', 'The chloroplast is the organelle responsible.')],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    const q1 = mappings[0]!.candidates.find((c) => c.questionId === 'q-1');
    expect(q1?.signals.labelKind).toBe('CONFLICTING_LABEL');
  });
});

describe('skipping adjudication', () => {
  /*
   * The adjudicator exists to break ties. Asking it about an answer whose
   * label names exactly one question, with nothing else near it, spends a
   * request and a slice of a rate limit on a conclusion already reached --
   * measured at five such calls per run, each paced eight seconds apart.
   *
   * The danger is skipping one that only looks decisive, so these pin both
   * sides: what may be skipped, and what may never be.
   */

  it('does not adjudicate when the label names one question and nothing is close', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', CHLOROPLAST_ANSWER)],
    );

    const provider = new FakeAIProvider();
    const { mappings } = await run(assessmentId, provider, semanticEmbeddings());

    expect(provider.adjudicateCalls).toBe(0);
    expect(mappings[0]!.questionId).toBe('q-1');
    expect(mappings[0]!.reasonCodes).toContain('DIRECT_LABEL_MATCH');
  });

  it('still adjudicates when the content belongs to another question', async () => {
    // The student wrote "Q1" over an answer about the heart. Semantics lift
    // q-2 toward the labelled q-1 and the margin collapses -- precisely the
    // case the gate must not swallow.
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', HEART_ANSWER)],
    );

    const provider = new FakeAIProvider();
    await run(assessmentId, provider, semanticEmbeddings());

    expect(provider.adjudicateCalls).toBeGreaterThan(0);
  });

  it('still adjudicates when a second question could carry the same label', async () => {
    // Two sub-parts both answer to a bare "(a)": a tie by definition, however
    // far apart the remaining signals place them.
    const assessmentId = await seed(
      [question('q-1', 'Q1(a)', 'State one use of a catalyst.'), question('q-2', 'Q2(a)', 'State one property of a gas.')],
      [answer('a-1', '(a)', 'A catalyst speeds up a reaction.')],
    );

    const provider = new FakeAIProvider();
    await run(assessmentId, provider, semanticEmbeddings());

    expect(provider.adjudicateCalls).toBeGreaterThan(0);
  });

  it('adjudicates everything when the margin floor is raised to 1', async () => {
    process.env.MAPPING_DECISIVE_MARGIN_MIN = '1';
    resetEnvCache();

    try {
      const assessmentId = await seed(
        [PHOTOSYNTHESIS, HEART],
        [answer('a-1', 'Q1', CHLOROPLAST_ANSWER)],
      );

      const provider = new FakeAIProvider();
      await run(assessmentId, provider, semanticEmbeddings());

      expect(provider.adjudicateCalls).toBeGreaterThan(0);
    } finally {
      delete process.env.MAPPING_DECISIVE_MARGIN_MIN;
      resetEnvCache();
    }
  });
});

describe('adjudication', () => {
  /*
   * These cover what the adjudicator does once it is asked, not when it is
   * asked -- and several of their fixtures are decisive enough that the gate
   * would now answer them without a call. The margin floor is raised to 1 so
   * every pair reaches the adjudicator, which is the documented way to say
   * "consult on everything" and keeps each test pinned to its own subject.
   */
  beforeEach(() => {
    process.env.MAPPING_DECISIVE_MARGIN_MIN = '1';
    resetEnvCache();
  });

  afterEach(() => {
    delete process.env.MAPPING_DECISIVE_MARGIN_MIN;
    resetEnvCache();
  });

  it('sends only the shortlist, never the whole paper', async () => {
    const questions = Array.from({ length: 12 }, (_, index) =>
      question(`q-${index}`, `Q${index + 1}`, `Question number ${index + 1} about biology.`),
    );

    const assessmentId = await seed(questions, [answer('a-1', 'Q1', 'An answer.')]);

    let seenCandidates = 0;
    const provider = new FakeAIProvider({
      onAdjudicate: (request: MappingAdjudicationRequest) => {
        seenCandidates = request.candidates.length;
      },
    });

    await run(assessmentId, provider, new FakeEmbeddingProvider());

    expect(seenCandidates).toBe(3);
    expect(seenCandidates).toBeLessThan(questions.length);
  });

  it('lets the adjudicator promote a different candidate', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', null, 'Something ambiguous about cells and blood.')],
    );

    const provider = new FakeAIProvider({
      adjudication: (request) => ({
        decision: 'MATCH',
        // Deliberately not the shortlist's own favourite.
        questionId: request.candidates[1]?.questionId ?? null,
        reasonCode: 'CONTENT_OVER_LABEL',
        confidence: 0.95,
        usage: null,
      }),
    });

    const { mappings } = await run(assessmentId, provider, new FakeEmbeddingProvider());
    const selected = mappings[0]!.candidates.find((c) => c.llmSelected);

    expect(selected).toBeDefined();
    expect(mappings[0]!.verification?.decision).toBe('MATCH');
  });

  it('accepts NO_MATCH without forcing a mapping', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', null, 'Entirely unrelated scribbling.')],
    );

    const provider = new FakeAIProvider({
      adjudication: {
        decision: 'NO_MATCH',
        questionId: null,
        reasonCode: 'UNRELATED',
        confidence: 0.2,
        usage: null,
      },
    });

    const { mappings } = await run(assessmentId, provider, new FakeEmbeddingProvider());

    expect(mappings[0]!.verification?.decision).toBe('NO_MATCH');
    expect(mappings[0]!.confidence).toBeLessThan(0.9);
  });

  it('rejects a question id that was never a candidate', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const provider = new FakeAIProvider({
      adjudication: {
        decision: 'MATCH',
        questionId: 'q-invented-by-the-model',
        reasonCode: 'SUBJECT_MATCH',
        confidence: 0.99,
        usage: null,
      },
    });

    const { mappings } = await run(assessmentId, provider, new FakeEmbeddingProvider());

    // The invented id is refused outright, not silently accepted.
    expect(mappings[0]!.verification?.reasonCode).toBe('INVALID_CANDIDATE_ID');
    expect(mappings[0]!.verification?.questionId).toBeNull();
    expect(mappings[0]!.candidates.every((c) => !c.llmSelected)).toBe(true);
  });

  /*
   * A per-minute token ceiling refuses one call, not the paper. Failing the
   * stage threw away a completed extraction over an advisory second opinion,
   * and on a metered tier it did so on nearly every run. The deterministic
   * signals are what the shortlist was built from and they still stand, so the
   * pair is decided without the model and says so.
   */
  it('maps without the adjudicator when it is transiently unavailable', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const provider = new FakeAIProvider({
      adjudicationError: new DependencyUnavailableError('rate limited'),
    });

    const { mappings, metadata } = await run(
      assessmentId,
      provider,
      new FakeEmbeddingProvider(),
    );

    expect(mappings).toHaveLength(1);
    expect(mappings[0]!.reasonCodes).toContain('LLM_UNAVAILABLE');
    expect(mappings[0]!.candidates.every((c) => c.llmConfidence === null)).toBe(true);

    // Reported as what it was: no consultation happened.
    expect(metadata.adjudicationCalls).toBe(0);

    // And the run still persisted its work rather than discarding it.
    expect((await getAssessment(assessmentId)).mappings).toHaveLength(1);
  });

  it('still fails the stage on a permanent adjudication error', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const provider = new FakeAIProvider({
      adjudicationError: new ValidationError('malformed request'),
    });

    await expect(run(assessmentId, provider, new FakeEmbeddingProvider())).rejects.toMatchObject({
      code: 'VALIDATION_ERROR',
      retryable: false,
    });
  });
});

describe('one-to-one assignment', () => {
  it('does not let two answers take the same question', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [
        answer('a-1', 'Q1', 'The chloroplast is the organelle responsible.'),
        answer('a-2', 'Q1', 'Also about the chloroplast and photosynthesis.'),
      ],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    const assigned = mappings
      .map((m) => m.questionId)
      .filter((id): id is string => id !== null);

    expect(new Set(assigned).size).toBe(assigned.length);
  });

  it('leaves an answer unmapped rather than forcing it onto a question', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS],
      [
        answer('a-1', 'Q1', 'The chloroplast is the organelle responsible.'),
        answer('a-2', 'Q9', 'Something about an entirely different subject.'),
      ],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    expect(mappings.filter((m) => m.questionId !== null)).toHaveLength(1);
    expect(mappings.some((m) => m.status === 'UNMAPPED')).toBe(true);
  });

  it('reports questions no answer reached', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART, OSMOSIS],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const { unmappedQuestionIds } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    expect(unmappedQuestionIds).toContain('q-2');
    expect(unmappedQuestionIds).toContain('q-3');
  });

  it('marks a mapping whose own favourite was taken elsewhere', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [
        answer('a-1', 'Q1', 'The chloroplast is responsible for photosynthesis.'),
        answer('a-2', 'Q1', 'The chloroplast is responsible for photosynthesis too.'),
      ],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    const contested = mappings.filter((m) => m.reasonCodes.includes('CONFLICT_RESOLVED'));
    expect(contested.length + mappings.filter((m) => m.status === 'UNMAPPED').length)
      .toBeGreaterThan(0);
  });
});

describe('dependencies', () => {
  it('refuses to map before questions exist', async () => {
    const assessmentId = await seed([], [answer('a-1', 'Q1', 'An answer.')]);
    const provider = new FakeAIProvider();
    const embeddings = new FakeEmbeddingProvider();

    await expect(run(assessmentId, provider, embeddings)).rejects.toThrow(ConflictError);
    expect(embeddings.embedCalls).toBe(0);
    expect(provider.adjudicateCalls).toBe(0);
  });

  it('refuses to map before answers exist', async () => {
    const assessmentId = await seed([PHOTOSYNTHESIS], []);
    const provider = new FakeAIProvider();
    const embeddings = new FakeEmbeddingProvider();

    await expect(run(assessmentId, provider, embeddings)).rejects.toThrow(ConflictError);
    expect(embeddings.embedCalls).toBe(0);
  });
});

describe('embedding cost', () => {
  it('embeds questions and answers in batches, not one at a time', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART, OSMOSIS],
      [answer('a-1', 'Q1', 'One.'), answer('a-2', 'Q2', 'Two.')],
    );

    const embeddings = new FakeEmbeddingProvider();
    await run(assessmentId, new FakeAIProvider(), embeddings);

    // One batch for the questions, one for the answers.
    expect(embeddings.embedCalls).toBe(2);
    expect(embeddings.embeddedTexts).toHaveLength(5);
  });

  it('embeds repeated text only once', async () => {
    const shared = 'The chloroplast is the organelle responsible.';

    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', shared), answer('a-2', 'Q2', shared)],
    );

    const embeddings = new FakeEmbeddingProvider();
    await run(assessmentId, new FakeAIProvider(), embeddings);

    const answerTexts = embeddings.embeddedTexts.filter((text) => text === shared);
    expect(answerTexts).toHaveLength(1);
  });
});

describe('idempotency', () => {
  it('does not repeat embedding or adjudication when mappings exist', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const provider = new FakeAIProvider();
    const embeddings = new FakeEmbeddingProvider();

    const first = await run(assessmentId, provider, embeddings);
    const second = await run(assessmentId, provider, embeddings);

    expect(second.reused).toBe(true);
    expect(provider.adjudicateCalls).toBe(1);
    expect(embeddings.embedCalls).toBe(2);
    expect(second.mappings.map((m) => m.answerId)).toEqual(
      first.mappings.map((m) => m.answerId),
    );
  });

  it('produces no duplicate mappings across repeated runs', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS, HEART],
      [answer('a-1', 'Q1', 'One.'), answer('a-2', 'Q2', 'Two.')],
    );

    const provider = new FakeAIProvider();
    const embeddings = new FakeEmbeddingProvider();

    await run(assessmentId, provider, embeddings);
    await run(assessmentId, provider, embeddings);
    await run(assessmentId, provider, embeddings);

    const stored = await getAssessment(assessmentId);
    expect(stored.mappings).toHaveLength(2);
    expect(new Set(stored.mappings.map((m) => m.answerId)).size).toBe(2);
  });
});

describe('source data', () => {
  it('never modifies the questions or answers it maps', async () => {
    const questions = [PHOTOSYNTHESIS, HEART];
    const answers = [answer('a-1', 'Q1', 'The chloroplast.')];

    const assessmentId = await seed(questions, answers);
    const before = JSON.stringify((await getAssessment(assessmentId)).questions);

    await run(assessmentId, new FakeAIProvider(), new FakeEmbeddingProvider());

    const stored = await getAssessment(assessmentId);

    expect(JSON.stringify(stored.questions)).toBe(before);
    // The mapping is a separate relationship; the answer gains no questionId.
    expect(stored.answers[0] as unknown as Record<string, unknown>).not.toHaveProperty(
      'questionId',
    );
  });

  it('records mapping metadata including the weights it used', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const { metadata } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    expect(metadata).toMatchObject({
      provider: 'fake',
      embeddingModel: 'fake-embedding-v1',
      promptVersion: 'mapping-adjudication/v1',
      questionCount: 1,
      answerCount: 1,
      topK: 3,
    });
    expect(metadata.weights.label).toBeGreaterThan(0);
    expect(metadata.thresholds.high).toBe(0.9);
  });

  it('performs no grading', async () => {
    const assessmentId = await seed(
      [PHOTOSYNTHESIS],
      [answer('a-1', 'Q1', 'The chloroplast.')],
    );

    const { mappings } = await run(
      assessmentId,
      new FakeAIProvider(),
      new FakeEmbeddingProvider(),
    );

    const raw = JSON.stringify(mappings);
    expect(raw).not.toContain('awarded');
    expect(raw).not.toContain('verdict');
    expect(raw).not.toContain('feedback');
  });
});
