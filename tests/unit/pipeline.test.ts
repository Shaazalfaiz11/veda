import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const enqueueAssessmentProcessing = vi.fn().mockResolvedValue({ id: 'job' });

vi.mock('@/lib/queue/queues', () => ({
  enqueueAssessmentProcessing: (...args: unknown[]) => enqueueAssessmentProcessing(...args),
  QUEUE_NAMES: { ASSESSMENT_PROCESSING: 'assessment-processing' },
}));

const { runAssessmentPipeline, recordPipelineFailure } = await import(
  '@/lib/services/pipeline/runner'
);
const { STAGE_HANDLERS } = await import('@/lib/services/pipeline/stages');
const { hasCompletedStage, idempotencyKey } = await import(
  '@/lib/services/pipeline/idempotency'
);
const { createAssessment, getAssessment, markStageCompleted, requestProcessing } = await import(
  '@/lib/services/assessment-service'
);
const { InMemoryAssessmentStore, setAssessmentStore } = await import(
  '@/lib/services/assessment-store'
);
const { JOB_NAMES } = await import('@/lib/queue/jobs');
const { ValidationError } = await import('@/lib/errors');

const store = new InMemoryAssessmentStore();
const originalHandlers = { ...STAGE_HANDLERS };

async function queuedAssessment() {
  const assessment = await createAssessment({});
  const ticket = await requestProcessing(assessment.id);
  return { assessmentId: assessment.id, jobId: ticket.jobId };
}

beforeEach(() => {
  store.clear();
  setAssessmentStore(store);

  // These tests exercise the runner's sequencing, idempotency and failure
  // handling. The implemented stages need real uploaded documents and an AI
  // provider, both covered by their own suites, so they are stubbed here.
  Object.assign(STAGE_HANDLERS, {
    [JOB_NAMES.PREPARE]: async () => undefined,
    [JOB_NAMES.EXTRACT_QUESTIONS]: async () => undefined,
    [JOB_NAMES.EXTRACT_ANSWERS]: async () => undefined,
    [JOB_NAMES.MAP_ANSWERS]: async () => undefined,
    [JOB_NAMES.GRADE]: async () => undefined,
  });
});

afterEach(() => {
  Object.assign(STAGE_HANDLERS, originalHandlers);
});

describe('pipeline execution', () => {
  it('runs every stage in order and completes the assessment', async () => {
    const job = await queuedAssessment();
    const outcome = await runAssessmentPipeline(job);

    expect(outcome.executedStages).toEqual([
      'PREPARING',
      'EXTRACTING_QUESTIONS',
      'EXTRACTING_ANSWERS',
      'MAPPING',
      'GRADING',
      'FINALIZING',
    ]);
    expect(outcome.skippedStages).toEqual([]);

    const stored = await getAssessment(job.assessmentId);
    expect(stored.status).toBe('COMPLETED');
    expect(stored.completedStages).toHaveLength(6);
  });

  it('hands each stage its own injected providers', async () => {
    const job = await queuedAssessment();
    const seen: string[] = [];

    Object.assign(STAGE_HANDLERS, {
      [JOB_NAMES.PREPARE]: async (ctx: { providers: { ai: { name: string } } }) => {
        seen.push(ctx.providers.ai.name);
      },
    });

    await runAssessmentPipeline(job, {
      providers: {
        ai: { name: 'injected' } as never,
        embeddings: { name: 'injected' } as never,
        documents: { name: 'injected' } as never,
      },
    });

    expect(seen).toEqual(['injected']);
  });
});

describe('idempotency', () => {
  it('builds the conceptual key from assessment id and stage', () => {
    expect(idempotencyKey('abc', 'MAPPING')).toBe('abc:MAPPING');
  });

  it('skips stages already recorded as complete', async () => {
    const job = await queuedAssessment();
    await markStageCompleted(job.assessmentId, 'PREPARING');
    await markStageCompleted(job.assessmentId, 'EXTRACTING_QUESTIONS');

    const outcome = await runAssessmentPipeline(job);

    expect(outcome.skippedStages).toEqual(['PREPARING', 'EXTRACTING_QUESTIONS']);
    expect(outcome.executedStages).toEqual([
      'EXTRACTING_ANSWERS',
      'MAPPING',
      'GRADING',
      'FINALIZING',
    ]);
  });

  it('does not re-run a completed stage handler on retry', async () => {
    const job = await queuedAssessment();
    const prepare = vi.fn().mockResolvedValue(undefined);
    Object.assign(STAGE_HANDLERS, { [JOB_NAMES.PREPARE]: prepare });

    await markStageCompleted(job.assessmentId, 'PREPARING');
    await runAssessmentPipeline(job);

    expect(prepare).not.toHaveBeenCalled();
  });

  it('resumes from the failing stage when a job is retried', async () => {
    const job = await queuedAssessment();
    let attempts = 0;

    Object.assign(STAGE_HANDLERS, {
      [JOB_NAMES.MAP_ANSWERS]: async () => {
        attempts += 1;
        if (attempts === 1) throw new Error('transient model timeout');
      },
    });

    await expect(runAssessmentPipeline(job)).rejects.toThrow('transient model timeout');

    const midway = await getAssessment(job.assessmentId);
    expect(hasCompletedStage(midway, 'EXTRACTING_ANSWERS')).toBe(true);
    expect(hasCompletedStage(midway, 'MAPPING')).toBe(false);

    // The retry re-enters at the top and fast-forwards past finished work.
    const outcome = await runAssessmentPipeline(job);

    expect(outcome.skippedStages).toEqual([
      'PREPARING',
      'EXTRACTING_QUESTIONS',
      'EXTRACTING_ANSWERS',
    ]);
    expect(outcome.executedStages).toEqual(['MAPPING', 'GRADING', 'FINALIZING']);
    expect(attempts).toBe(2);

    const stored = await getAssessment(job.assessmentId);
    expect(stored.status).toBe('COMPLETED');
  });
});

describe('pipeline failure', () => {
  it('propagates the error and leaves the assessment mid-flight for the queue to decide', async () => {
    const job = await queuedAssessment();
    Object.assign(STAGE_HANDLERS, {
      [JOB_NAMES.GRADE]: async () => {
        throw new Error('grading blew up');
      },
    });

    await expect(runAssessmentPipeline(job)).rejects.toThrow('grading blew up');

    // Not FAILED yet — an intermediate attempt is not a terminal outcome.
    const stored = await getAssessment(job.assessmentId);
    expect(stored.status).toBe('PROCESSING');
    expect(stored.stage).toBe('GRADING');
  });

  it('records terminal failure once the queue gives up', async () => {
    const job = await queuedAssessment();
    Object.assign(STAGE_HANDLERS, {
      [JOB_NAMES.GRADE]: async () => {
        throw new ValidationError('unreadable answer sheet');
      },
    });

    await expect(runAssessmentPipeline(job)).rejects.toThrow(ValidationError);
    await recordPipelineFailure(job, new ValidationError('unreadable answer sheet'), 'GRADING');

    const stored = await getAssessment(job.assessmentId);
    expect(stored.status).toBe('FAILED');
    expect(stored.failure).toMatchObject({
      code: 'VALIDATION_ERROR',
      message: 'unreadable answer sheet',
      stage: 'GRADING',
    });
  });
});
