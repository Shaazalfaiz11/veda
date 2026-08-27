import { beforeEach, describe, expect, it, vi } from 'vitest';

// The queue is mocked so these stay unit tests: they assert that the service
// hands the right payload to BullMQ, not that BullMQ works.
const enqueueAssessmentProcessing = vi.fn();

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: (...args: unknown[]) => enqueueAssessmentProcessing(...args),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const {
  createAssessment,
  getAssessment,
  getAssessmentStatus,
  markCompleted,
  markFailed,
  markProcessing,
  markStageCompleted,
  requestProcessing,
} = await import('@/lib/services/assessment-service');

const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { ConflictError, NotFoundError } = await import('@/lib/errors');

const store = new InMemoryAssessmentStore();

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);
  enqueueAssessmentProcessing.mockReset();
  enqueueAssessmentProcessing.mockResolvedValue({ id: 'job' });
});

describe('assessment creation', () => {
  it('creates an assessment in CREATED with no job attached', async () => {
    const assessment = await createAssessment({ title: 'Class 10 maths' });

    expect(assessment.status).toBe('CREATED');
    expect(assessment.stage).toBeNull();
    expect(assessment.jobId).toBeNull();
    expect(assessment.title).toBe('Class 10 maths');
    expect(assessment.completedStages).toEqual([]);
    expect(assessment.failure).toBeNull();
    expect(assessment.id).toMatch(/^[0-9a-f-]{36}$/);
  });

  it('starts with no documents — they arrive through the upload endpoint', async () => {
    const assessment = await createAssessment({});
    expect(assessment.title).toBeNull();
    expect(assessment.documents).toEqual([]);
  });
});

describe('unknown assessments', () => {
  it('throws NotFoundError when fetching an id that does not exist', async () => {
    await expect(getAssessment('11111111-2222-3333-4444-555555555555')).rejects.toThrow(
      NotFoundError,
    );
  });

  it('throws NotFoundError when processing an id that does not exist', async () => {
    await expect(requestProcessing('11111111-2222-3333-4444-555555555555')).rejects.toThrow(
      NotFoundError,
    );
    expect(enqueueAssessmentProcessing).not.toHaveBeenCalled();
  });
});

describe('queue job creation', () => {
  it('moves the assessment to QUEUED and enqueues exactly one job', async () => {
    const assessment = await createAssessment({});
    const ticket = await requestProcessing(assessment.id);

    expect(ticket.status).toBe('QUEUED');
    expect(ticket.assessmentId).toBe(assessment.id);
    expect(ticket.jobId).toMatch(/^[0-9a-f-]{36}$/);

    expect(enqueueAssessmentProcessing).toHaveBeenCalledTimes(1);
    expect(enqueueAssessmentProcessing).toHaveBeenCalledWith({
      assessmentId: assessment.id,
      jobId: ticket.jobId,
    });

    const stored = await getAssessment(assessment.id);
    expect(stored.status).toBe('QUEUED');
    expect(stored.jobId).toBe(ticket.jobId);
  });

  it('commits the QUEUED status before the job is enqueued', async () => {
    const assessment = await createAssessment({});

    // If the worker were instant, it must never observe a stale CREATED.
    enqueueAssessmentProcessing.mockImplementation(async () => {
      const observed = await getAssessment(assessment.id);
      expect(observed.status).toBe('QUEUED');
      return { id: 'job' };
    });

    await requestProcessing(assessment.id);
    expect.assertions(1);
  });

  it('rolls the assessment back when the enqueue fails', async () => {
    const assessment = await createAssessment({});
    enqueueAssessmentProcessing.mockRejectedValue(new Error('redis unreachable'));

    await expect(requestProcessing(assessment.id)).rejects.toThrow('redis unreachable');

    const stored = await getAssessment(assessment.id);
    expect(stored.status).toBe('CREATED');
    expect(stored.jobId).toBeNull();
  });

  it('refuses to queue an assessment that is already queued', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);

    await expect(requestProcessing(assessment.id)).rejects.toThrow(ConflictError);
    expect(enqueueAssessmentProcessing).toHaveBeenCalledTimes(1);
  });

  it('clears the previous run history when a failed assessment is requeued', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);
    await markProcessing(assessment.id, 'PREPARING');
    await markStageCompleted(assessment.id, 'PREPARING');
    await markFailed(assessment.id, { code: 'INTERNAL_ERROR', message: 'boom', stage: 'MAPPING' });

    const requeued = await requestProcessing(assessment.id);

    const stored = await getAssessment(assessment.id);
    expect(stored.status).toBe('QUEUED');
    expect(stored.completedStages).toEqual([]);
    expect(stored.failure).toBeNull();
    expect(stored.jobId).toBe(requeued.jobId);
  });
});

describe('status view', () => {
  it('reports queued work at zero progress', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);

    const status = await getAssessmentStatus(assessment.id);
    expect(status).toMatchObject({ status: 'QUEUED', stage: null, progress: 0 });
    expect(status.documents).toEqual([]);
  });

  it('derives progress from the current stage', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);
    await markProcessing(assessment.id, 'EXTRACTING_ANSWERS');

    const status = await getAssessmentStatus(assessment.id);
    expect(status.status).toBe('PROCESSING');
    expect(status.stage).toBe('EXTRACTING_ANSWERS');
    expect(status.progress).toBe(33);
  });

  it('reports 100 once complete', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);
    await markProcessing(assessment.id, 'FINALIZING');
    await markCompleted(assessment.id);

    const status = await getAssessmentStatus(assessment.id);
    expect(status).toMatchObject({ status: 'COMPLETED', stage: null, progress: 100 });
  });

  it('surfaces the recorded failure', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);
    await markProcessing(assessment.id, 'MAPPING');
    await markFailed(assessment.id, {
      code: 'DEPENDENCY_UNAVAILABLE',
      message: 'model timeout',
      stage: 'MAPPING',
    });

    const status = await getAssessmentStatus(assessment.id);
    expect(status.status).toBe('FAILED');
    expect(status.failure).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', stage: 'MAPPING' });
  });
});

describe('stage bookkeeping', () => {
  it('records a completed stage once, even if marked twice', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);
    await markStageCompleted(assessment.id, 'PREPARING');
    await markStageCompleted(assessment.id, 'PREPARING');

    const stored = await getAssessment(assessment.id);
    expect(stored.completedStages).toHaveLength(1);
  });

  it('leaves a completed assessment alone when a late failure arrives', async () => {
    const assessment = await createAssessment({});
    await requestProcessing(assessment.id);
    await markProcessing(assessment.id, 'FINALIZING');
    await markCompleted(assessment.id);

    await markFailed(assessment.id, { code: 'INTERNAL_ERROR', message: 'late', stage: 'GRADING' });

    const stored = await getAssessment(assessment.id);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.failure).toBeNull();
  });
});
