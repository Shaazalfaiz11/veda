import { z } from 'zod';
import type { JobsOptions } from 'bullmq';
import { getEnv } from '@/lib/config';
import type { ProcessingStage } from '@/lib/domain/assessment';

/**
 * Pipeline step names.
 *
 * One BullMQ job covers a whole assessment; these name the steps the worker
 * walks through inside it, and appear on every log line. Per-step retry
 * safety comes from the idempotency record (assessmentId + stage) rather
 * than from splitting the pipeline into six queued jobs — a replay re-enters
 * at the first stage that has not been recorded as complete.
 */
export const JOB_NAMES = {
  PREPARE: 'PREPARE',
  EXTRACT_QUESTIONS: 'EXTRACT_QUESTIONS',
  EXTRACT_ANSWERS: 'EXTRACT_ANSWERS',
  MAP_ANSWERS: 'MAP_ANSWERS',
  GRADE: 'GRADE',
  FINALIZE: 'FINALIZE',
} as const;

export type JobName = (typeof JOB_NAMES)[keyof typeof JOB_NAMES];

/** The job actually enqueued: the pipeline entry point. */
export const ASSESSMENT_JOB_NAME: JobName = JOB_NAMES.PREPARE;

/** Each pipeline step maps onto the stage reported by the status endpoint. */
export const JOB_STAGE: Record<JobName, ProcessingStage> = {
  [JOB_NAMES.PREPARE]: 'PREPARING',
  [JOB_NAMES.EXTRACT_QUESTIONS]: 'EXTRACTING_QUESTIONS',
  [JOB_NAMES.EXTRACT_ANSWERS]: 'EXTRACTING_ANSWERS',
  [JOB_NAMES.MAP_ANSWERS]: 'MAPPING',
  [JOB_NAMES.GRADE]: 'GRADING',
  [JOB_NAMES.FINALIZE]: 'FINALIZING',
};

/** Execution order of the pipeline. */
export const JOB_SEQUENCE: readonly JobName[] = [
  JOB_NAMES.PREPARE,
  JOB_NAMES.EXTRACT_QUESTIONS,
  JOB_NAMES.EXTRACT_ANSWERS,
  JOB_NAMES.MAP_ANSWERS,
  JOB_NAMES.GRADE,
  JOB_NAMES.FINALIZE,
];

export const AssessmentJobDataSchema = z.object({
  assessmentId: z.string().uuid(),
  jobId: z.string().min(1),
});

export type AssessmentJobData = z.infer<typeof AssessmentJobDataSchema>;

/**
 * Retry policy, centralised.
 *
 * Exponential backoff covers transient failures — a Redis blip, a model
 * timeout. Permanent failures never reach these attempts: the worker throws
 * BullMQ's UnrecoverableError for them, which stops retrying immediately.
 */
export function buildJobOptions(overrides: JobsOptions = {}): JobsOptions {
  const { JOB_MAX_ATTEMPTS, JOB_BACKOFF_MS } = getEnv();

  return {
    attempts: JOB_MAX_ATTEMPTS,
    backoff: { type: 'exponential', delay: JOB_BACKOFF_MS },
    // Keep a bounded history: enough to inspect a failure, not enough to
    // grow without limit.
    removeOnComplete: { age: 3600, count: 100 },
    removeOnFail: { age: 86_400, count: 500 },
    ...overrides,
  };
}
