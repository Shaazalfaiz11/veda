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
const { DependencyUnavailableError, InvalidDocumentError } = await import('@/lib/errors');
const { resetEnvCache } = await import('@/lib/config');
const { logger } = await import('@/lib/logger');
const { makePng } = await import('../fixtures/documents');

import type { AssessmentDocument, PreparedPage } from '@/lib/domain/document';
import type { ExtractedAnswerCandidate, PageImage } from '@/lib/providers/ai';

/**
 * Chunked answer extraction.
 *
 * A long sheet is read as overlapping page chunks, so these cover the things
 * that only exist because of the split: chunk-local page numbers being
 * translated back to absolute ones, duplicates from the overlap being merged,
 * ordering surviving the reassembly, and a lost chunk being reported rather
 * than absorbed.
 *
 * Every response is scripted. No test here calls a real model.
 */

const store = new InMemoryAssessmentStore();
let storageRoot: string;

type Fake = InstanceType<typeof FakeAIProvider>;

/** Chunk settings pinned here so a change to the defaults cannot silently rewrite these. */
const CHUNK_PAGES = 4;
const CHUNK_OVERLAP = 1;

function region(pageNumber: number, y = 0.2) {
  return { pageNumber, x: 0.1, y, width: 0.7, height: 0.1, kind: 'text' as const };
}

function candidate(
  overrides: Partial<ExtractedAnswerCandidate> = {},
): ExtractedAnswerCandidate {
  return {
    claimedLabelRaw: 'Q1',
    text: 'The chloroplast is the organelle responsible.',
    regions: [region(1)],
    ...overrides,
  };
}

async function seed(pageCount: number): Promise<string> {
  const assessment = await createAssessment({ title: 'chunked extraction' });
  const documentId = '7c9e6679-7425-40de-944b-e07fc1f90ae7';
  const storage = getDocumentStorage();
  const pages: PreparedPage[] = [];

  for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
    const key = preparedPageKey(assessment.id, documentId, pageNumber);
    const stored = await storage.put(key, await makePng(60, 80), { contentType: 'image/png' });

    pages.push({
      documentId,
      pageNumber,
      storageKey: key,
      width: 60,
      height: 80,
      aspectRatio: 0.75,
      sourceWidth: 60,
      sourceHeight: 80,
      scale: 1,
      rotation: 0,
      mimeType: 'image/png',
      sizeBytes: stored.sizeBytes,
    });
  }

  const document: AssessmentDocument = {
    id: documentId,
    assessmentId: assessment.id,
    type: 'ANSWER_SHEET',
    status: 'READY',
    originalFilename: 'answers.pdf',
    storageKey: `assessments/${assessment.id}/${documentId}/original`,
    format: 'PDF',
    mimeType: 'application/pdf',
    sizeBytes: 1024,
    pageCount,
    pages,
    failure: null,
    uploadedAt: new Date().toISOString(),
    preparedAt: new Date().toISOString(),
  };

  await store.update(assessment.id, (current) => ({
    ...current,
    documents: [document],
  }));

  return assessment.id;
}

function run(assessmentId: string, provider: Fake) {
  return extractAnswers({ assessmentId, jobId: 'job-1', logger, provider });
}

/** The absolute pages each call received, so translation can be checked. */
function pagesPerCall(provider: Fake): number[][] {
  return provider.answerCallPages.map((pages: PageImage[]) =>
    pages.map((page) => page.pageNumber),
  );
}

beforeAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  env['ANSWER_CHUNK_PAGES'] = String(CHUNK_PAGES);
  env['ANSWER_CHUNK_OVERLAP'] = String(CHUNK_OVERLAP);
  env['ANSWER_CHUNK_DELAY_MS'] = '0';
  env['ANSWER_CHUNK_MAX_ATTEMPTS'] = '2';
  resetEnvCache();

  storageRoot = await mkdtemp(join(tmpdir(), 'veda-chunked-'));
  setDocumentStorage(new LocalDocumentStorage(storageRoot));
});

afterAll(async () => {
  const env = process.env as Record<string, string | undefined>;
  delete env['ANSWER_CHUNK_PAGES'];
  delete env['ANSWER_CHUNK_OVERLAP'];
  delete env['ANSWER_CHUNK_DELAY_MS'];
  delete env['ANSWER_CHUNK_MAX_ATTEMPTS'];
  resetEnvCache();

  setDocumentStorage(null);
  await rm(storageRoot, { recursive: true, force: true });
});

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
});

describe('splitting the sheet', () => {
  it('reads a 2-page sheet in one call, exactly as before chunking', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });
    const outcome = await run(await seed(2), provider);

    expect(provider.extractAnswersCalls).toBe(1);
    expect(pagesPerCall(provider)).toEqual([[1, 2]]);
    expect(outcome.metadata.chunkCount).toBe(1);
  });

  it('reads a 4-page sheet in one call', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });
    await run(await seed(4), provider);

    expect(pagesPerCall(provider)).toEqual([[1, 2, 3, 4]]);
  });

  it('splits a 10-page sheet into overlapping chunks', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [] });
    const outcome = await run(await seed(10), provider);

    expect(pagesPerCall(provider)).toEqual([
      [1, 2, 3, 4],
      [4, 5, 6, 7],
      [7, 8, 9, 10],
    ]);
    expect(outcome.metadata.chunkCount).toBe(3);
  });

  it('covers every page of an 18-page sheet', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [] });
    await run(await seed(18), provider);

    const covered = new Set(pagesPerCall(provider).flat());
    expect(covered.size).toBe(18);
  });
});

describe('translating chunk-local page numbers', () => {
  /**
   * The prompt tells the model the first image it was given is page 1, so a
   * chunk covering pages 7-10 answers in pages 1-4. Left untranslated, every
   * answer past the first chunk lands on the wrong page — and its overlay is
   * drawn over unrelated handwriting.
   */
  it('rewrites a later chunk’s local pages as absolute ones', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) =>
        // Only the third chunk (pages 7-10) answers, and it calls its own
        // second image "page 2".
        pages[0]?.pageNumber === 7
          ? [candidate({ regions: [region(2, 0.3)] })]
          : [],
    });

    const outcome = await run(await seed(10), provider);

    expect(outcome.answers).toHaveLength(1);
    // Local page 2 of chunk [7,8,9,10] is absolute page 8.
    expect(outcome.answers[0]!.pageNumbers).toEqual([8]);
  });

  it('drops a candidate citing a page its chunk never held', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) =>
        pages[0]?.pageNumber === 1
          ? [candidate({ regions: [region(9)] }), candidate({ regions: [region(1)] })]
          : [],
    });

    const outcome = await run(await seed(10), provider);

    // The invented page-9-of-a-4-page-chunk candidate is gone; the real one stays.
    expect(outcome.answers).toHaveLength(1);
    expect(outcome.answers[0]!.pageNumbers).toEqual([1]);
  });
});

describe('answers spanning a chunk boundary', () => {
  /**
   * The reason the overlap exists. Chunk 0 holds pages 1-4 and sees only the
   * start; chunk 1 holds 4-7 and reads the whole thing. One answer must come
   * out, and it must be the complete reading.
   */
  it('keeps a spanning answer whole and does not duplicate it', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) => {
        const first = pages[0]?.pageNumber;

        if (first === 1) {
          // Sees page 4 only, so reads the answer cut off.
          return [
            candidate({
              claimedLabelRaw: 'Q5',
              text: 'Blood from the body enters the right atrium and then passes',
              regions: [{ ...region(4, 0.7) }],
            }),
          ];
        }

        if (first === 4) {
          // Holds pages 4 and 5, so reads it whole.
          return [
            candidate({
              claimedLabelRaw: 'Q5',
              text: 'Blood from the body enters the right atrium and then passes into the ventricle.',
              regions: [region(1, 0.7), region(2, 0.1)],
            }),
          ];
        }

        return [];
      },
    });

    const outcome = await run(await seed(7), provider);

    expect(outcome.answers).toHaveLength(1);

    const answer = outcome.answers[0]!;
    expect(answer.text).toContain('into the ventricle');
    expect(answer.pageNumbers).toEqual([4, 5]);
    expect(answer.spansPages).toBe(true);
  });

  it('records how many duplicate readings the overlap produced', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) =>
        pages.some((page) => page.pageNumber === 4)
          ? [candidate({ regions: [region(pages[0]!.pageNumber === 1 ? 4 : 1, 0.5)] })]
          : [],
    });

    const outcome = await run(await seed(7), provider);

    expect(outcome.answers).toHaveLength(1);
    expect(outcome.metadata.duplicatesMerged).toBe(1);
  });
});

describe('ordering', () => {
  it('returns answers in document order regardless of which chunk found them', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) => {
        const first = pages[0]!.pageNumber;
        // Each chunk reports one answer near the top of its own first page.
        return [
          candidate({
            claimedLabelRaw: `Q${first}`,
            text: `Answer written on page ${first}.`,
            regions: [region(1, 0.1)],
          }),
        ];
      },
    });

    const outcome = await run(await seed(10), provider);

    const pages = outcome.answers.map((answer) => answer.pageNumbers[0]);
    expect(pages).toEqual([...pages].sort((a, b) => a! - b!));
    expect(outcome.answers.map((answer) => answer.documentPosition)).toEqual([0, 1, 2]);
  });
});

describe('a chunk that fails', () => {
  it('keeps the answers that were read and reports the loss', async () => {
    const provider = new FakeAIProvider({
      answerError: (pages: PageImage[]) =>
        pages[0]?.pageNumber === 4 ? new InvalidDocumentError('Malformed reply.') : null,
      answerCandidates: (pages: PageImage[]) => [
        candidate({
          claimedLabelRaw: `Q${pages[0]!.pageNumber}`,
          text: `Answer on page ${pages[0]!.pageNumber}.`,
          regions: [region(1, 0.1)],
        }),
      ],
    });

    const outcome = await run(await seed(10), provider);

    expect(outcome.metadata.partial).toBe(true);
    expect(outcome.metadata.failedChunks).toHaveLength(1);
    expect(outcome.metadata.failedChunks[0]!.pageNumbers).toEqual([4, 5, 6, 7]);
    // The two chunks that did work are still persisted.
    expect(outcome.answers).toHaveLength(2);
  });

  it('names the lost pages in a warning rather than absorbing the failure', async () => {
    const provider = new FakeAIProvider({
      answerError: (pages: PageImage[]) =>
        pages[0]?.pageNumber === 7 ? new InvalidDocumentError('Malformed reply.') : null,
      answerCandidates: [candidate({ regions: [region(1, 0.1)] })],
    });

    const outcome = await run(await seed(10), provider);
    const warning = outcome.metadata.warnings.find((entry) => entry.code === 'CHUNK_FAILED');

    expect(warning?.message).toContain('7-10');
    expect(warning?.message).toContain('missing');
  });

  it('marks a clean run as not partial', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [candidate()] });
    const outcome = await run(await seed(10), provider);

    expect(outcome.metadata.partial).toBe(false);
    expect(outcome.metadata.failedChunks).toEqual([]);
  });

  it('retries a transient chunk failure before giving up on it', async () => {
    let firstAttempt = true;

    const provider = new FakeAIProvider({
      answerError: (pages: PageImage[]) => {
        if (pages[0]?.pageNumber === 1 && firstAttempt) {
          firstAttempt = false;
          return new DependencyUnavailableError('Gemini is unavailable.');
        }
        return null;
      },
      answerCandidates: [candidate({ regions: [region(1, 0.1)] })],
    });

    const outcome = await run(await seed(10), provider);

    // Three chunks, one of which was attempted twice.
    expect(provider.extractAnswersCalls).toBe(4);
    expect(outcome.metadata.partial).toBe(false);
  });

  /**
   * A permanent failure produces the same reply however many times it is
   * sent, so retrying it only spends quota.
   */
  it('does not retry a permanent chunk failure', async () => {
    const provider = new FakeAIProvider({
      answerError: (pages: PageImage[]) =>
        pages[0]?.pageNumber === 1 ? new InvalidDocumentError('Malformed reply.') : null,
      answerCandidates: [candidate({ regions: [region(1, 0.1)] })],
    });

    await run(await seed(10), provider);

    // Chunk 0 attempted once, chunks 1 and 2 once each.
    expect(provider.extractAnswersCalls).toBe(3);
  });

  /**
   * Nothing was read at all, so there is no partial result worth keeping and
   * the queue should be allowed to retry the whole stage.
   */
  it('fails the stage when every chunk fails', async () => {
    const provider = new FakeAIProvider({
      answerError: new DependencyUnavailableError('Gemini is unavailable.'),
    });
    const assessmentId = await seed(10);

    await expect(run(assessmentId, provider)).rejects.toThrow(DependencyUnavailableError);

    const stored = await getAssessment(assessmentId);
    expect(stored.answers).toEqual([]);
    expect(stored.answerExtraction).toBeNull();
  });

  it('accepts a sheet where every chunk legitimately found nothing', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [] });
    const outcome = await run(await seed(10), provider);

    expect(outcome.answers).toEqual([]);
    expect(outcome.metadata.partial).toBe(false);
  });
});

describe('validation still owns what is accepted', () => {
  it('rejects a wholly unreadable answer found in a chunk', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) =>
        pages[0]?.pageNumber === 1
          ? [
              candidate({ regions: [region(1, 0.1)] }),
              candidate({ text: '[unclear]', regions: [region(2, 0.5)] }),
            ]
          : [],
    });

    const outcome = await run(await seed(10), provider);

    expect(outcome.answers).toHaveLength(1);
    expect(outcome.metadata.candidatesRejected).toBe(1);
  });

  it('keeps a partly unreadable answer', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) =>
        pages[0]?.pageNumber === 1
          ? [candidate({ text: 'Force equals [unclear] times acceleration.' })]
          : [],
    });

    const outcome = await run(await seed(10), provider);

    expect(outcome.answers).toHaveLength(1);
    expect(outcome.answers[0]!.hasUncertainSegments).toBe(true);
  });

  it('counts the candidates the model actually returned, not the merged total', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: (pages: PageImage[]) =>
        pages.some((page) => page.pageNumber === 4)
          ? [candidate({ regions: [region(pages[0]!.pageNumber === 1 ? 4 : 1, 0.5)] })]
          : [],
    });

    const outcome = await run(await seed(7), provider);

    // Two readings of one answer: both received, one merged away.
    expect(outcome.metadata.candidatesReceived).toBe(2);
    expect(outcome.metadata.duplicatesMerged).toBe(1);
    expect(outcome.answers).toHaveLength(1);
  });
});

describe('provenance', () => {
  it('sums usage across the chunks', async () => {
    const provider = new FakeAIProvider({
      answerCandidates: [],
      answerUsage: { promptTokens: 100, responseTokens: 40, totalTokens: 140 },
    });

    const outcome = await run(await seed(10), provider);

    // Three chunks.
    expect(outcome.metadata.usage).toEqual({
      promptTokens: 300,
      responseTokens: 120,
      totalTokens: 420,
    });
  });

  it('records the chunk count alongside the page count', async () => {
    const provider = new FakeAIProvider({ answerCandidates: [] });
    const outcome = await run(await seed(18), provider);

    expect(outcome.metadata.pagesProcessed).toBe(18);
    expect(outcome.metadata.chunkCount).toBeGreaterThan(1);
  });
});
