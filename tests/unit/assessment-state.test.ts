import { describe, expect, it } from 'vitest';
import {
  allowedTransitionsFrom,
  assertTransition,
  canTransition,
  isTerminal,
  nextStage,
  progressFor,
  progressForStage,
  stageIndex,
  ASSESSMENT_STATUSES,
  PROCESSING_STAGES,
} from '@/lib/domain/assessment';
import { ConflictError } from '@/lib/errors';

describe('assessment state transitions', () => {
  it('permits the happy path CREATED -> QUEUED -> PROCESSING -> COMPLETED', () => {
    expect(canTransition('CREATED', 'QUEUED')).toBe(true);
    expect(canTransition('QUEUED', 'PROCESSING')).toBe(true);
    expect(canTransition('PROCESSING', 'COMPLETED')).toBe(true);
  });

  it('permits failure from every non-terminal status', () => {
    expect(canTransition('CREATED', 'FAILED')).toBe(true);
    expect(canTransition('QUEUED', 'FAILED')).toBe(true);
    expect(canTransition('PROCESSING', 'FAILED')).toBe(true);
  });

  it('allows a failed assessment to be requeued', () => {
    expect(canTransition('FAILED', 'QUEUED')).toBe(true);
  });

  it('treats COMPLETED as terminal', () => {
    expect(allowedTransitionsFrom('COMPLETED')).toHaveLength(0);
    expect(isTerminal('COMPLETED')).toBe(true);
    expect(isTerminal('FAILED')).toBe(true);
    expect(isTerminal('PROCESSING')).toBe(false);
  });

  it('rejects skipping straight from CREATED to COMPLETED', () => {
    expect(canTransition('CREATED', 'COMPLETED')).toBe(false);
    expect(() => assertTransition('CREATED', 'COMPLETED')).toThrow(ConflictError);
  });

  it('rejects reopening a completed assessment', () => {
    expect(() => assertTransition('COMPLETED', 'PROCESSING')).toThrow(ConflictError);
  });

  it('names every status in the transition table', () => {
    for (const status of ASSESSMENT_STATUSES) {
      expect(allowedTransitionsFrom(status)).toBeDefined();
    }
  });
});

describe('pipeline stage ordering', () => {
  it('orders stages from PREPARING through FINALIZING', () => {
    expect(stageIndex('PREPARING')).toBe(0);
    expect(stageIndex('FINALIZING')).toBe(PROCESSING_STAGES.length - 1);
  });

  it('walks to the next stage and stops at the end', () => {
    expect(nextStage('PREPARING')).toBe('EXTRACTING_QUESTIONS');
    expect(nextStage('GRADING')).toBe('FINALIZING');
    expect(nextStage('FINALIZING')).toBeNull();
  });
});

describe('progress derivation', () => {
  it('reports 0 before work begins and 100 when complete', () => {
    expect(progressFor('CREATED', null)).toBe(0);
    expect(progressFor('QUEUED', null)).toBe(0);
    expect(progressFor('COMPLETED', null)).toBe(100);
  });

  it('increases monotonically across the pipeline', () => {
    const values = PROCESSING_STAGES.map((stage) => progressForStage(stage));
    for (let i = 1; i < values.length; i += 1) {
      expect(values[i]!).toBeGreaterThan(values[i - 1]!);
    }
  });

  it('derives progress from the stage while processing', () => {
    expect(progressFor('PROCESSING', 'EXTRACTING_ANSWERS')).toBe(33);
    expect(progressFor('PROCESSING', 'MAPPING')).toBe(50);
  });

  it('freezes progress at the failing stage so the caller sees how far it got', () => {
    expect(progressFor('FAILED', 'MAPPING')).toBe(50);
  });
});
