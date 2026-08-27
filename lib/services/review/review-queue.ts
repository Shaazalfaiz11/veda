import { randomUUID } from 'node:crypto';
import type { AnswerMapping } from '@/lib/domain/mapping';
import type { MappingReview, ReviewTrigger } from '@/lib/domain/review';

/**
 * Deciding what a human needs to look at.
 *
 * The rule is conservative in one direction only: anything the system is not
 * confident about is surfaced, and a HIGH-confidence auto-mapping is left
 * alone. That asymmetry is deliberate — the cost of a teacher glancing at a
 * correct mapping is a few seconds, and the cost of a wrong mapping reaching
 * grading unchallenged is a wrong mark on a real student's paper.
 *
 * `needsReview` is a pure predicate so the policy can be read, tested and
 * changed in one place rather than being spread through the service.
 */

export function reviewTriggerFor(mapping: AnswerMapping): ReviewTrigger | null {
  // Nothing was assigned at all.
  if (mapping.questionId === null) {
    if (mapping.reasonCodes.includes('NO_CANDIDATES')) return 'NO_CANDIDATES';
    if (mapping.reasonCodes.includes('LLM_NO_MATCH')) return 'AI_NO_MATCH';
    return 'UNMAPPED';
  }

  if (mapping.confidenceBand === 'LOW') return 'LOW_CONFIDENCE';
  if (mapping.confidenceBand === 'MEDIUM') return 'MEDIUM_CONFIDENCE';

  // A HIGH-confidence mapping that only won because the optimiser moved it
  // off its own first choice is worth a look, even though the number is good.
  if (mapping.reasonCodes.includes('CONFLICT_RESOLVED')) return 'CONFLICT_RESOLVED';

  return null;
}

export function needsReview(mapping: AnswerMapping): boolean {
  return reviewTriggerFor(mapping) !== null;
}

/**
 * Builds the review items a mapping run implies.
 *
 * Existing reviews are preserved untouched: a teacher's decision is not
 * discarded because mapping ran again, and a review already in the queue is
 * not duplicated. Only answers with no review yet get one.
 */
export function buildReviewQueue(
  assessmentId: string,
  mappings: readonly AnswerMapping[],
  existing: readonly MappingReview[],
): MappingReview[] {
  const byAnswerId = new Map(existing.map((review) => [review.answerId, review]));
  const now = new Date().toISOString();

  const reviews: MappingReview[] = [...existing];

  for (const mapping of mappings) {
    if (byAnswerId.has(mapping.answerId)) continue;

    const trigger = reviewTriggerFor(mapping);
    if (trigger === null) continue;

    reviews.push({
      id: randomUUID(),
      assessmentId,
      answerId: mapping.answerId,
      status: 'PENDING',
      trigger,
      // Snapshot, not reference: this is what the AI said at this moment, and
      // it stays true even if mapping is re-run later.
      original: {
        mappingId: mapping.id,
        questionId: mapping.questionId,
        status: mapping.status,
        confidence: mapping.confidence,
        confidenceBand: mapping.confidenceBand,
        signals: mapping.signals,
        reasonCodes: [...mapping.reasonCodes],
        candidates: mapping.candidates.map((candidate) => ({ ...candidate })),
        adjudication: mapping.verification ? { ...mapping.verification } : null,
        mappedAt: mapping.createdAt,
      },
      decision: null,
      createdAt: now,
      updatedAt: now,
    });
  }

  return reviews;
}
