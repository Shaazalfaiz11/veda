import { ConflictError } from '@/lib/errors';
import {
  type AssessmentStatus,
  type ProcessingStage,
  PROCESSING_STAGES,
} from './types';

/**
 * Permitted status transitions.
 *
 * FAILED can return to QUEUED so a failed assessment is reprocessable;
 * COMPLETED is genuinely terminal — reprocessing a finished assessment
 * would be a new assessment, not a transition of this one.
 */
const ALLOWED_TRANSITIONS: Record<AssessmentStatus, readonly AssessmentStatus[]> = {
  CREATED: ['QUEUED', 'FAILED'],
  QUEUED: ['PROCESSING', 'FAILED'],
  PROCESSING: ['COMPLETED', 'FAILED'],
  COMPLETED: [],
  FAILED: ['QUEUED'],
};

export function canTransition(from: AssessmentStatus, to: AssessmentStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertTransition(from: AssessmentStatus, to: AssessmentStatus): void {
  if (!canTransition(from, to)) {
    throw new ConflictError(
      `Cannot transition assessment from ${from} to ${to}.`,
      { from, to, allowed: ALLOWED_TRANSITIONS[from] },
    );
  }
}

export function allowedTransitionsFrom(status: AssessmentStatus): readonly AssessmentStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

/** Pipeline order. The worker walks these in sequence. */
export const STAGE_ORDER: readonly ProcessingStage[] = PROCESSING_STAGES;

export function stageIndex(stage: ProcessingStage): number {
  return STAGE_ORDER.indexOf(stage);
}

export function nextStage(stage: ProcessingStage): ProcessingStage | null {
  const next = STAGE_ORDER[stageIndex(stage) + 1];
  return next ?? null;
}
