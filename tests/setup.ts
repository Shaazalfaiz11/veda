/**
 * Test environment. Values here keep `getEnv()` satisfiable without a real
 * .env file, and pin the Redis key prefix so integration tests can never
 * collide with development data.
 */
// Next.js types NODE_ENV as readonly; the assignment is legitimate here.
const env = process.env as Record<string, string | undefined>;

env['NODE_ENV'] = 'test';
env['REDIS_URL'] ??= 'redis://localhost:6379';
env['REDIS_KEY_PREFIX'] = 'veda-test';
env['LOG_LEVEL'] ??= 'silent';
env['JOB_MAX_ATTEMPTS'] ??= '3';
env['JOB_BACKOFF_MS'] ??= '50';
env['WORKER_CONCURRENCY'] ??= '1';
env['ASSESSMENT_TTL_SECONDS'] ??= '300';
env['GRADING_CALL_DELAY_MS'] ??= '0';
env['QUESTION_CHUNK_BACKOFF_MS'] ??= '0';
env['QUESTION_CHUNK_DELAY_MS'] ??= '0';
