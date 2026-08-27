import type { AssessmentStatus, ProcessingStage } from './types';
import { STAGE_ORDER, stageIndex } from './state';

/**
 * Progress is derived from the stage rather than stored, so it can never
 * drift out of sync with the pipeline position. A stage that has *started*
 * reports the progress at its entry point; finishing the last stage is what
 * takes the assessment to 100.
 */
export function progressForStage(stage: ProcessingStage | null): number {
  if (stage === null) return 0;
  const index = stageIndex(stage);
  if (index < 0) return 0;
  return Math.round((index / STAGE_ORDER.length) * 100);
}

export function progressFor(status: AssessmentStatus, stage: ProcessingStage | null): number {
  switch (status) {
    case 'CREATED':
      return 0;
    case 'QUEUED':
      return 0;
    case 'PROCESSING':
      return progressForStage(stage);
    case 'COMPLETED':
      return 100;
    case 'FAILED':
      // Freeze at wherever it broke, so the caller can see how far it got.
      return progressForStage(stage);
  }
}
