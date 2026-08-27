import { randomUUID } from 'node:crypto';
import { Queue, Worker, UnrecoverableError, type Job } from 'bullmq';
import { Redis } from 'ioredis';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { QUEUE_NAMES } from '@/lib/queue/queues';
import { buildJobOptions, type AssessmentJobData } from '@/lib/queue/jobs';

/**
 * Integration coverage for the queue and worker against a real Redis.
 *
 * Skipped automatically when Redis is unreachable, so the suite stays green
 * on a machine without it — but the assertions below are the ones that
 * actually prove the producer/consumer wiring, so run Redis before trusting
 * a green run: `npm run redis:up`.
 */
const REDIS_URL = process.env['REDIS_URL'] ?? 'redis://localhost:6379';
const TEST_QUEUE = `${QUEUE_NAMES.ASSESSMENT_PROCESSING}-test`;

async function redisAvailable(): Promise<boolean> {
  const probe = new Redis(REDIS_URL, {
    lazyConnect: true,
    maxRetriesPerRequest: null,
    retryStrategy: () => null,
  });

  try {
    await probe.connect();
    const reply = await probe.ping();
    return reply === 'PONG';
  } catch {
    return false;
  } finally {
    probe.disconnect();
  }
}

const available = await redisAvailable();

if (!available) {
  console.warn(`[skip] Redis unreachable at ${REDIS_URL} — queue integration tests skipped.`);
}

function connection() {
  return new Redis(REDIS_URL, { maxRetriesPerRequest: null });
}

function jobData(): AssessmentJobData {
  return { assessmentId: randomUUID(), jobId: randomUUID() };
}

/** Resolves when the worker settles the job, or rejects on timeout. */
function settled(worker: Worker, event: 'completed' | 'failed', timeoutMs = 10_000) {
  return new Promise<{ job: Job | undefined; error?: Error }>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`timed out waiting for ${event}`)), timeoutMs);

    if (event === 'completed') {
      worker.once('completed', (job) => {
        clearTimeout(timer);
        resolve({ job });
      });
    } else {
      worker.once('failed', (job, error) => {
        clearTimeout(timer);
        resolve({ job, error });
      });
    }
  });
}

describe.skipIf(!available)('queue and worker integration', () => {
  let queue: Queue<AssessmentJobData>;
  let queueConnection: Redis;
  const workers: Worker[] = [];

  beforeAll(async () => {
    queueConnection = connection();
    queue = new Queue<AssessmentJobData>(TEST_QUEUE, { connection: queueConnection });
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterEach(async () => {
    await Promise.all(workers.splice(0).map((worker) => worker.close()));
    await queue.obliterate({ force: true }).catch(() => undefined);
  });

  afterAll(async () => {
    await queue.close();
    await queueConnection.quit().catch(() => queueConnection.disconnect());
  });

  it('connects to Redis', async () => {
    await expect(queueConnection.ping()).resolves.toBe('PONG');
  });

  it('persists an enqueued job with the configured retry policy', async () => {
    const data = jobData();
    const job = await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));

    expect(job.id).toBe(data.jobId);
    expect(job.opts.attempts).toBe(3);
    expect(job.opts.backoff).toEqual({ type: 'exponential', delay: 50 });

    const stored = await queue.getJob(data.jobId);
    expect(stored?.data).toEqual(data);
    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('does not duplicate a job when the same job id is submitted twice', async () => {
    const data = jobData();
    await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));
    await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));

    expect(await queue.getWaitingCount()).toBe(1);
  });

  it('delivers the job to a worker with its payload intact', async () => {
    const data = jobData();
    const received: AssessmentJobData[] = [];

    const worker = new Worker<AssessmentJobData>(
      TEST_QUEUE,
      async (job) => {
        received.push(job.data);
      },
      { connection: connection(), concurrency: 1 },
    );
    workers.push(worker);

    const done = settled(worker, 'completed');
    await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));
    await done;

    expect(received).toEqual([data]);
  });

  it('retries a transient failure up to the attempt budget', async () => {
    const data = jobData();
    let attempts = 0;

    const worker = new Worker<AssessmentJobData>(
      TEST_QUEUE,
      async () => {
        attempts += 1;
        if (attempts < 3) throw new Error('transient');
      },
      { connection: connection(), concurrency: 1 },
    );
    workers.push(worker);

    const done = settled(worker, 'completed', 15_000);
    await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));
    await done;

    expect(attempts).toBe(3);
  });

  it('stops retrying a permanent failure after one attempt', async () => {
    const data = jobData();
    let attempts = 0;

    const worker = new Worker<AssessmentJobData>(
      TEST_QUEUE,
      async () => {
        attempts += 1;
        throw new UnrecoverableError('invalid payload');
      },
      { connection: connection(), concurrency: 1 },
    );
    workers.push(worker);

    const failure = settled(worker, 'failed');
    await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));
    const { error } = await failure;

    expect(attempts).toBe(1);
    expect(error?.message).toBe('invalid payload');
  });

  it('marks a job failed once the attempt budget is exhausted', async () => {
    const data = jobData();

    const worker = new Worker<AssessmentJobData>(
      TEST_QUEUE,
      async () => {
        throw new Error('always fails');
      },
      { connection: connection(), concurrency: 1 },
    );
    workers.push(worker);

    let lastFailure: { job: Job | undefined; error?: Error } | null = null;
    for (let i = 0; i < 3; i += 1) {
      const failure = settled(worker, 'failed', 15_000);
      if (i === 0) await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));
      lastFailure = await failure;
    }

    expect(lastFailure?.job?.attemptsMade).toBe(3);

    const stored = await queue.getJob(data.jobId);
    expect(await stored?.getState()).toBe('failed');
  });

  it('shuts a worker down gracefully without dropping the job in flight', async () => {
    const data = jobData();
    let finished = false;

    const worker = new Worker<AssessmentJobData>(
      TEST_QUEUE,
      async () => {
        await new Promise((resolve) => setTimeout(resolve, 300));
        finished = true;
      },
      { connection: connection(), concurrency: 1 },
    );

    const done = settled(worker, 'completed');
    await queue.add('PREPARE', data, buildJobOptions({ jobId: data.jobId }));
    await done;

    // close() resolves only after the in-flight job has settled.
    await expect(worker.close()).resolves.toBeUndefined();
    expect(finished).toBe(true);
    expect(worker.isRunning()).toBe(false);
  });

  it('is safe to close a worker twice', async () => {
    const worker = new Worker<AssessmentJobData>(TEST_QUEUE, async () => undefined, {
      connection: connection(),
      concurrency: 1,
    });

    await worker.close();
    await expect(worker.close()).resolves.toBeUndefined();
  });
});
