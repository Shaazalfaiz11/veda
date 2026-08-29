import './load-env';

import { Worker, UnrecoverableError, type Job } from 'bullmq';
import { getEnv } from '@/lib/config';
import { isRetryable } from '@/lib/errors';
import { jobLogger, logger } from '@/lib/logger';
import {
  createRedisConnection,
  closeRedisConnection,
  pingRedis,
} from '@/lib/queue/connection';
import { QUEUE_NAMES } from '@/lib/queue/queues';
import { AssessmentJobDataSchema, type AssessmentJobData } from '@/lib/queue/jobs';
import { runAssessmentPipeline, recordPipelineFailure } from '@/lib/services/pipeline';
import { getAssessment } from '@/lib/services/assessment-service';
// TEMPORARY DIAGNOSTIC — stall investigation.
import { startLoopProbe } from '@/lib/diagnostics/loop-probe';

/**
 * Assessment processing worker.
 *
 * Runs as its own Node process (`npm run dev:worker`). It owns no AI code —
 * the pipeline calls providers through interfaces, so this file stays a
 * queue adapter and nothing more.
 */

const env = getEnv();

const connection = createRedisConnection('worker');

async function processJob(job: Job<AssessmentJobData>): Promise<void> {
  // Job payloads cross a process boundary, so they are validated on arrival
  // exactly like an HTTP body would be.
  const parsed = AssessmentJobDataSchema.safeParse(job.data);

  if (!parsed.success) {
    // A malformed payload cannot be fixed by retrying it.
    throw new UnrecoverableError(
      `Invalid job payload: ${parsed.error.issues.map((i) => i.message).join('; ')}`,
    );
  }

  const data = parsed.data;
  const attempt = job.attemptsMade + 1;

  const log = jobLogger({
    assessmentId: data.assessmentId,
    jobId: data.jobId,
    stage: 'PIPELINE',
    status: 'RECEIVED',
    attempt,
    maxAttempts: env.JOB_MAX_ATTEMPTS,
  });

  log.info('assessment.job.received');

  try {
    await runAssessmentPipeline(data);
  } catch (error) {
    if (!isRetryable(error)) {
      // Permanent failure: record it now and tell BullMQ to stop.
      const assessment = await getAssessment(data.assessmentId).catch(() => null);
      await recordPipelineFailure(data, error, assessment?.stage ?? null);

      throw new UnrecoverableError(
        error instanceof Error ? error.message : 'Permanent pipeline failure.',
      );
    }

    throw error;
  }
}

startLoopProbe();

const worker = new Worker<AssessmentJobData>(QUEUE_NAMES.ASSESSMENT_PROCESSING, processJob, {
  connection,
  concurrency: env.WORKER_CONCURRENCY,
});

worker.on('completed', (job) => {
  jobLogger({
    assessmentId: job.data.assessmentId,
    jobId: job.data.jobId,
    stage: 'PIPELINE',
    status: 'COMPLETED',
  }).info('assessment.job.completed');
});

worker.on('failed', async (job, error) => {
  if (!job) {
    logger.error({ err: { message: error.message } }, 'assessment.job.failed_without_job');
    return;
  }

  const attempt = job.attemptsMade;
  const exhausted = attempt >= (job.opts.attempts ?? env.JOB_MAX_ATTEMPTS);
  const permanent = error instanceof UnrecoverableError;

  const log = jobLogger({
    assessmentId: job.data.assessmentId,
    jobId: job.data.jobId,
    stage: 'PIPELINE',
    status: 'FAILED',
    attempt,
    exhausted,
    permanent,
  });

  log.error({ reason: error.message }, 'assessment.job.failed');

  // Mark the assessment FAILED only once the queue has genuinely given up —
  // an intermediate attempt is not a terminal outcome.
  if (exhausted || permanent) {
    try {
      const assessment = await getAssessment(job.data.assessmentId).catch(() => null);
      await recordPipelineFailure(job.data, error, assessment?.stage ?? null);
    } catch (recordError) {
      log.error(
        { reason: recordError instanceof Error ? recordError.message : 'unknown' },
        'assessment.job.failure_record_error',
      );
    }
  }
});

worker.on('error', (error) => {
  logger.error({ err: { message: error.message } }, 'assessment.worker.error');
});

// TEMPORARY DIAGNOSTIC — stall investigation.
worker.on('stalled', (jobId) => {
  logger.error({ jobId }, 'diag.job.stalled');
});

async function bootstrap(): Promise<void> {
  const reachable = await pingRedis(connection);

  if (!reachable) {
    logger.error(
      { queue: QUEUE_NAMES.ASSESSMENT_PROCESSING },
      'assessment.worker.redis_unreachable',
    );
    process.exitCode = 1;
    await shutdown('REDIS_UNREACHABLE');
    return;
  }

  logger.info(
    {
      queue: QUEUE_NAMES.ASSESSMENT_PROCESSING,
      concurrency: env.WORKER_CONCURRENCY,
      maxAttempts: env.JOB_MAX_ATTEMPTS,
    },
    'assessment.worker.started',
  );
}

let shuttingDown = false;

/**
 * Graceful shutdown: stop accepting new jobs, let the in-flight one finish,
 * then release both Redis connections. A second signal is ignored rather
 * than tearing down a close that is already running.
 */
async function shutdown(signal: string): Promise<void> {
  if (shuttingDown) return;
  shuttingDown = true;

  logger.info({ signal }, 'assessment.worker.shutdown.started');

  try {
    await worker.close();
    await connection.quit().catch(() => connection.disconnect());
    await closeRedisConnection();
    logger.info({ signal }, 'assessment.worker.shutdown.completed');
  } catch (error) {
    logger.error(
      { signal, err: { message: error instanceof Error ? error.message : 'unknown' } },
      'assessment.worker.shutdown.failed',
    );
    process.exitCode = 1;
  }
}

for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.on(signal, () => {
    void shutdown(signal).then(() => process.exit(process.exitCode ?? 0));
  });
}

void bootstrap();

export { worker, shutdown };
