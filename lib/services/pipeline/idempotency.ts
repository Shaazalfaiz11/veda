import type { Assessment, ProcessingStage } from '@/lib/domain/assessment';

/**
 * Idempotency.
 *
 * The conceptual key is `assessmentId + stage`. A retry re-enters the
 * pipeline at the top, so without a guard it would re-run stages that
 * already succeeded — wasted model calls at best, duplicated results at
 * worst. Completed stages are recorded on the assessment, and the guard
 * skips anything already present.
 *
 * The record is cleared when a new run is requested, so reprocessing an
 * assessment genuinely redoes the work rather than skipping everything.
 */
export function idempotencyKey(assessmentId: string, stage: ProcessingStage): string {
  return `${assessmentId}:${stage}`;
}

export function hasCompletedStage(assessment: Assessment, stage: ProcessingStage): boolean {
  return assessment.completedStages.some((record) => record.stage === stage);
}

export function completedStageKeys(assessment: Assessment): string[] {
  return assessment.completedStages.map((record) => idempotencyKey(assessment.id, record.stage));
}
