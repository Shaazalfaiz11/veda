import { isAppError, isRetryable } from '@/lib/errors';
import type { ProcessingStage } from '@/lib/domain/assessment';
import { jobLogger } from '@/lib/logger';
import { getProviders, type ProviderRegistry } from '@/lib/providers';
import { JOB_SEQUENCE, JOB_STAGE, type AssessmentJobData } from '@/lib/queue/jobs';
import {
  getAssessment,
  markCompleted,
  markFailed,
  markProcessing,
  markStageCompleted,
} from '@/lib/services/assessment-service';
import { hasCompletedStage } from './idempotency';
import { STAGE_HANDLERS, type StageContext } from './stages';

export interface PipelineOptions {
  providers?: ProviderRegistry;
}

export interface PipelineOutcome {
  assessmentId: string;
  jobId: string;
  executedStages: string[];
  skippedStages: string[];
}

/**
 * Walks the pipeline for one assessment.
 *
 * Stages run in order. Each is skipped if the idempotency record already
 * shows it complete, which is what makes a retry safe: the job re-enters at
 * the top and fast-forwards to the first stage that has not finished.
 */
export async function runAssessmentPipeline(
  data: AssessmentJobData,
  options: PipelineOptions = {},
): Promise<PipelineOutcome> {
  const { assessmentId, jobId } = data;
  const providers = options.providers ?? getProviders();

  const executedStages: string[] = [];
  const skippedStages: string[] = [];

  const runLogger = jobLogger({
    assessmentId,
    jobId,
    stage: 'PIPELINE',
    status: 'PROCESSING',
  });

  runLogger.info('assessment.processing.started');

  let currentStage = JOB_STAGE[JOB_SEQUENCE[0]!];

  try {
    for (const jobName of JOB_SEQUENCE) {
      const stage = JOB_STAGE[jobName];
      currentStage = stage;

      const assessment = await getAssessment(assessmentId);

      if (hasCompletedStage(assessment, stage)) {
        skippedStages.push(stage);
        runLogger.info({ stage, status: 'SKIPPED' }, 'assessment.stage.skipped');
        continue;
      }

      await markProcessing(assessmentId, stage);

      const stageLogger = jobLogger({ assessmentId, jobId, stage, status: 'STARTED' });
      stageLogger.info('assessment.stage.started');

      const context: StageContext = {
        assessmentId,
        jobId,
        jobName,
        stage,
        providers,
        logger: stageLogger,
      };

      await STAGE_HANDLERS[jobName](context);
      await markStageCompleted(assessmentId, stage);

      executedStages.push(stage);
      jobLogger({ assessmentId, jobId, stage, status: 'COMPLETED' }).info(
        'assessment.stage.completed',
      );
    }

    await markCompleted(assessmentId);

    jobLogger({ assessmentId, jobId, stage: 'PIPELINE', status: 'COMPLETED' }).info(
      { executedStages, skippedStages },
      'assessment.processing.completed',
    );

    return { assessmentId, jobId, executedStages, skippedStages };
  } catch (error) {
    const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
    const message = error instanceof Error ? error.message : 'Unknown pipeline failure.';

    // Only record terminal failure once the queue has exhausted its
    // attempts; the caller decides, since it knows the attempt count.
    jobLogger({ assessmentId, jobId, stage: currentStage, status: 'FAILED' }).error(
      { code, message, retryable: isRetryable(error) },
      'assessment.processing.failed',
    );

    throw error;
  }
}

/** Records the terminal failure after the queue has given up on a job. */
export async function recordPipelineFailure(
  data: AssessmentJobData,
  error: unknown,
  stage: ProcessingStage | null,
): Promise<void> {
  const code = isAppError(error) ? error.code : 'INTERNAL_ERROR';
  const message = error instanceof Error ? error.message : 'Unknown pipeline failure.';

  await markFailed(data.assessmentId, { code, message, stage });
}
