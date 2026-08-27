import { describe, expect, it, vi } from 'vitest';

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: vi.fn().mockResolvedValue({ id: 'job' }),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { InMemoryAssessmentStore } = await import('@/lib/services/assessment-store');

import type { Assessment } from '@/lib/domain/assessment';

/**
 * Concurrent updates to one assessment.
 *
 * Observed for real: two document uploads racing produced two 201s and one
 * stored document. Both stores must apply every mutation, because "the upload
 * succeeded but the file is gone" is indistinguishable from data loss to
 * anyone downstream.
 */
function seed(id: string): Assessment {
  const now = new Date().toISOString();
  return {
    id,
    status: 'CREATED',
    stage: null,
    jobId: null,
    title: null,
    documents: [],
    questions: [],
    questionExtraction: null,
    answers: [],
    answerExtraction: null,
    mappings: [],
    mapping: null,
    reviews: [],
    reviewAudit: [],
    markSchemes: null,
    grades: [],
    grading: null,
    completedStages: [],
    failure: null,
    createdAt: now,
    updatedAt: now,
  };
}

describe('concurrent updates', () => {
  it('applies every concurrent append rather than losing one', async () => {
    const store = new InMemoryAssessmentStore();
    const id = 'a1b2c3d4-0000-4000-8000-000000000001';
    await store.create(seed(id));

    // The upload case: two appends launched together, neither awaiting the other.
    await Promise.all([
      store.update(id, (current) => ({
        ...current,
        completedStages: [...current.completedStages, { stage: 'PREPARING', completedAt: 'a' }],
      })),
      store.update(id, (current) => ({
        ...current,
        completedStages: [...current.completedStages, { stage: 'MAPPING', completedAt: 'b' }],
      })),
    ]);

    const stored = await store.get(id);
    expect(stored.completedStages.map((s) => s.stage).sort()).toEqual(['MAPPING', 'PREPARING']);
  });

  it('applies many concurrent appends without dropping any', async () => {
    const store = new InMemoryAssessmentStore();
    const id = 'a1b2c3d4-0000-4000-8000-000000000002';
    await store.create(seed(id));

    await Promise.all(
      Array.from({ length: 20 }, (_, i) =>
        store.update(id, (current) => ({
          ...current,
          completedStages: [
            ...current.completedStages,
            { stage: 'PREPARING', completedAt: String(i) },
          ],
        })),
      ),
    );

    expect((await store.get(id)).completedStages).toHaveLength(20);
  });

  it('keeps serialising after one update throws', async () => {
    const store = new InMemoryAssessmentStore();
    const id = 'a1b2c3d4-0000-4000-8000-000000000003';
    await store.create(seed(id));

    const results = await Promise.allSettled([
      store.update(id, () => {
        throw new Error('mutation failed');
      }),
      store.update(id, (current) => ({ ...current, title: 'survived' })),
    ]);

    expect(results[0]!.status).toBe('rejected');
    expect((await store.get(id)).title).toBe('survived');
  });
});
