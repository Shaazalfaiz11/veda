import { Queue, type Job } from 'bullmq';
import { getRedisConnection } from './connection';
import {
  ASSESSMENT_JOB_NAME,
  buildJobOptions,
  type AssessmentJobData,
} from './jobs';
import { logger } from '@/lib/logger';

export const QUEUE_NAMES = {
  ASSESSMENT_PROCESSING: 'assessment-processing',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

const globalForQueue = globalThis as unknown as {
  __vedaAssessmentQueue?: Queue<AssessmentJobData>;
};

export function getAssessmentQueue(): Queue<AssessmentJobData> {
  if (!globalForQueue.__vedaAssessmentQueue) {
    globalForQueue.__vedaAssessmentQueue = new Queue<AssessmentJobData>(
      QUEUE_NAMES.ASSESSMENT_PROCESSING,
      { connection: getRedisConnection() },
    );
  }
  return globalForQueue.__vedaAssessmentQueue;
}

/**
 * Enqueue one processing run.
 *
 * The BullMQ job id is set to the caller-supplied `jobId`, which makes the
 * enqueue idempotent: re-submitting the same id is a no-op rather than a
 * duplicate run.
 */
export async function enqueueAssessmentProcessing(
  data: AssessmentJobData,
): Promise<Job<AssessmentJobData>> {
  const queue = getAssessmentQueue();

  const job = await queue.add(ASSESSMENT_JOB_NAME, data, buildJobOptions({ jobId: data.jobId }));

  logger.info(
    {
      assessmentId: data.assessmentId,
      jobId: data.jobId,
      queue: QUEUE_NAMES.ASSESSMENT_PROCESSING,
      status: 'QUEUED',
    },
    'assessment.processing.enqueued',
  );

  return job;
}

export async function closeQueues(): Promise<void> {
  const queue = globalForQueue.__vedaAssessmentQueue;
  if (!queue) return;

  globalForQueue.__vedaAssessmentQueue = undefined;
  await queue.close();
}
