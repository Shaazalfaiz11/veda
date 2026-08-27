import '../workers/load-env';
import { createAssessment } from '../lib/services/assessment-service';
import { getAssessmentStore } from '../lib/services/assessment-store';
import { closeRedisConnection } from '../lib/queue/connection';
import type { AssessmentStatus, ProcessingStage } from '../lib/domain/assessment';

/**
 * Puts a real assessment into a chosen pipeline state, in real Redis.
 *
 * Used to park the processing screen at a specific stage for the Figma
 * measurement pass. This is a fixture, not a mock: the page still polls the
 * live `/status` endpoint and renders whatever the store actually holds —
 * only the route into that state is short-circuited, because reaching
 * EXTRACTING_QUESTIONS honestly needs a worker and Gemini quota.
 *
 *   npx tsx tools/seed-processing.ts [stage|FAILED|COMPLETED]
 */
async function main(): Promise<void> {
  const arg = process.argv[2] ?? 'EXTRACTING_QUESTIONS';
  const store = getAssessmentStore();

  const assessment = await createAssessment({ title: 'processing fixture' });

  const failing = arg === 'FAILED';
  const completed = arg === 'COMPLETED';
  const stage = (
    failing ? 'EXTRACTING_QUESTIONS' : completed ? 'FINALIZING' : arg
  ) as ProcessingStage;
  const status: AssessmentStatus = failing
    ? 'FAILED'
    : completed
      ? 'COMPLETED'
      : 'PROCESSING';

  await store.update(assessment.id, (current) => ({
    ...current,
    status,
    stage,
    jobId: 'fixture-job',
    failure: failing
      ? {
          code: 'DEPENDENCY_UNAVAILABLE',
          message: 'Gemini rate limit exceeded.',
          stage,
          failedAt: new Date().toISOString(),
        }
      : null,
    updatedAt: new Date().toISOString(),
  }));

  console.log(assessment.id);

  // ioredis keeps the event loop alive; without this the script never exits.
  await closeRedisConnection();
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
});
