import { describe, expect, it } from 'vitest';
import { buildReviewQueue, needsReview, reviewTriggerFor } from '@/lib/services/review';
import {
  allowedReviewTransitionsFrom,
  assertReviewTransition,
  canTransitionReview,
  isReviewSettled,
  statusForAction,
} from '@/lib/domain/review';
import { ConflictError } from '@/lib/errors';
import type { AnswerMapping, MappingReasonCode } from '@/lib/domain/mapping';

const ASSESSMENT_ID = '3f2504e0-4f89-11d3-9a0c-0305e82c3301';

function mapping(overrides: Partial<AnswerMapping> = {}): AnswerMapping {
  return {
    id: 'm-1',
    answerId: 'a-1',
    questionId: 'q-1',
    status: 'AUTO_MAPPED',
    confidence: 0.95,
    confidenceBand: 'HIGH',
    signals: {
      label: 1,
      labelKind: 'EXACT_NORMALIZED_LABEL',
      semantic: 0.9,
      semanticCosine: 0.93,
      position: 0.7,
      structure: 0.6,
    },
    reasonCodes: ['DIRECT_LABEL_MATCH'],
    candidates: [],
    verification: null,
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('what needs a human', () => {
  it('leaves a confident auto-mapping alone', () => {
    const confident = mapping({ confidenceBand: 'HIGH', status: 'AUTO_MAPPED' });

    expect(reviewTriggerFor(confident)).toBeNull();
    expect(needsReview(confident)).toBe(false);
  });

  it('queues a medium-confidence mapping', () => {
    expect(reviewTriggerFor(mapping({ confidenceBand: 'MEDIUM' }))).toBe('MEDIUM_CONFIDENCE');
  });

  it('queues a low-confidence mapping', () => {
    expect(reviewTriggerFor(mapping({ confidenceBand: 'LOW' }))).toBe('LOW_CONFIDENCE');
  });

  it('queues an answer that reached no question', () => {
    expect(
      reviewTriggerFor(mapping({ questionId: null, status: 'UNMAPPED', reasonCodes: [] })),
    ).toBe('UNMAPPED');
  });

  it('distinguishes an AI NO_MATCH from a plain unmapped answer', () => {
    const noMatch = mapping({
      questionId: null,
      status: 'UNMAPPED',
      reasonCodes: ['LLM_NO_MATCH', 'NO_MATCH'] as MappingReasonCode[],
    });

    expect(reviewTriggerFor(noMatch)).toBe('AI_NO_MATCH');
  });

  it('distinguishes an answer with no candidates at all', () => {
    const none = mapping({
      questionId: null,
      status: 'UNMAPPED',
      reasonCodes: ['NO_CANDIDATES', 'NO_MATCH'] as MappingReasonCode[],
    });

    expect(reviewTriggerFor(none)).toBe('NO_CANDIDATES');
  });

  it('queues a confident mapping that only won after a conflict was resolved', () => {
    // The number is good, but the optimiser moved it off its own first
    // choice — worth a glance even at HIGH confidence.
    const contested = mapping({
      confidenceBand: 'HIGH',
      reasonCodes: ['DIRECT_LABEL_MATCH', 'CONFLICT_RESOLVED'] as MappingReasonCode[],
    });

    expect(reviewTriggerFor(contested)).toBe('CONFLICT_RESOLVED');
  });
});

describe('building the queue', () => {
  it('creates a review only for mappings that need one', () => {
    const reviews = buildReviewQueue(
      ASSESSMENT_ID,
      [
        mapping({ id: 'm-1', answerId: 'a-1', confidenceBand: 'HIGH' }),
        mapping({ id: 'm-2', answerId: 'a-2', confidenceBand: 'MEDIUM' }),
        mapping({ id: 'm-3', answerId: 'a-3', confidenceBand: 'LOW' }),
      ],
      [],
    );

    expect(reviews.map((r) => r.answerId)).toEqual(['a-2', 'a-3']);
    expect(reviews.every((r) => r.status === 'PENDING')).toBe(true);
  });

  it('snapshots the AI decision rather than referencing it', () => {
    const source = mapping({ confidenceBand: 'MEDIUM', confidence: 0.78 });
    const [review] = buildReviewQueue(ASSESSMENT_ID, [source], []);

    expect(review!.original).toMatchObject({
      mappingId: 'm-1',
      questionId: 'q-1',
      confidence: 0.78,
      confidenceBand: 'MEDIUM',
    });

    // Mutating the source afterwards must not reach into the snapshot.
    source.reasonCodes.push('LOW_CONFIDENCE');
    expect(review!.original.reasonCodes).toEqual(['DIRECT_LABEL_MATCH']);
  });

  it('never duplicates a review for an answer that already has one', () => {
    const mappings = [mapping({ confidenceBand: 'MEDIUM' })];
    const first = buildReviewQueue(ASSESSMENT_ID, mappings, []);
    const second = buildReviewQueue(ASSESSMENT_ID, mappings, first);

    expect(second).toHaveLength(1);
    expect(second[0]!.id).toBe(first[0]!.id);
  });

  it('preserves a decision already made when mapping runs again', () => {
    const mappings = [mapping({ confidenceBand: 'MEDIUM' })];
    const [existing] = buildReviewQueue(ASSESSMENT_ID, mappings, []);

    const resolved = {
      ...existing!,
      status: 'RESOLVED' as const,
      decision: {
        action: 'ACCEPT' as const,
        questionId: null,
        reason: null,
        reviewerId: 'teacher-1',
        decidedAt: '2026-01-02T00:00:00.000Z',
      },
    };

    const rebuilt = buildReviewQueue(ASSESSMENT_ID, mappings, [resolved]);

    expect(rebuilt).toHaveLength(1);
    expect(rebuilt[0]!.status).toBe('RESOLVED');
    expect(rebuilt[0]!.decision?.reviewerId).toBe('teacher-1');
  });

  it('returns nothing when every mapping is confident', () => {
    expect(buildReviewQueue(ASSESSMENT_ID, [mapping()], [])).toEqual([]);
  });
});

describe('review state machine', () => {
  it('follows PENDING to RESOLVED', () => {
    expect(canTransitionReview('PENDING', 'IN_REVIEW')).toBe(true);
    expect(canTransitionReview('IN_REVIEW', 'RESOLVED')).toBe(true);
    expect(canTransitionReview('PENDING', 'RESOLVED')).toBe(true);
  });

  it('lets a skipped item be picked up again', () => {
    // Deferring is precisely a statement that it will be revisited.
    expect(canTransitionReview('SKIPPED', 'IN_REVIEW')).toBe(true);
    expect(canTransitionReview('SKIPPED', 'RESOLVED')).toBe(true);
    expect(isReviewSettled('SKIPPED')).toBe(false);
  });

  it('treats RESOLVED as terminal', () => {
    expect(allowedReviewTransitionsFrom('RESOLVED')).toHaveLength(0);
    expect(isReviewSettled('RESOLVED')).toBe(true);
    expect(() => assertReviewTransition('RESOLVED', 'IN_REVIEW')).toThrow(ConflictError);
  });

  it('maps each action onto the status it produces', () => {
    expect(statusForAction('ACCEPT')).toBe('RESOLVED');
    expect(statusForAction('REMAP')).toBe('RESOLVED');
    expect(statusForAction('REJECT')).toBe('RESOLVED');
    // SKIP is explicitly not a resolution.
    expect(statusForAction('SKIP')).toBe('SKIPPED');
  });
});
