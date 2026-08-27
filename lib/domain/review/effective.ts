import type { AnswerMapping } from '@/lib/domain/mapping';
import type { EffectiveMapping, MappingReview } from './types';

/**
 * Resolving what the system should actually act on.
 *
 * Derived on read rather than stored. A stored `effectiveQuestionId` would be
 * a third copy of a fact that already lives in two places, and the first time
 * it drifted nobody would know which of the three was right.
 *
 * The rule is small enough to state completely:
 *
 *   - a resolved human decision wins
 *   - ACCEPT means the human agreed, so the AI's question stands, but the
 *     source is still HUMAN: someone looked and signed it off
 *   - REJECT means no mapping, whatever the AI thought
 *   - SKIP is not a decision, so the AI's mapping continues to apply
 */
export function resolveEffectiveMapping(
  mapping: AnswerMapping,
  review: MappingReview | null,
): EffectiveMapping {
  const decision = review?.decision;

  if (!decision || decision.action === 'SKIP') {
    return {
      answerId: mapping.answerId,
      questionId: mapping.questionId,
      source: 'AI',
      confidence: mapping.confidence,
      confidenceBand: mapping.confidenceBand,
    };
  }

  if (decision.action === 'REJECT') {
    return {
      answerId: mapping.answerId,
      questionId: null,
      source: 'HUMAN',
      confidence: null,
      confidenceBand: null,
    };
  }

  // ACCEPT keeps the AI's question; REMAP substitutes the teacher's. Both are
  // human decisions, and both are recorded as such.
  const questionId =
    decision.action === 'ACCEPT' ? mapping.questionId : decision.questionId;

  return {
    answerId: mapping.answerId,
    questionId,
    source: 'HUMAN',
    confidence: null,
    confidenceBand: null,
  };
}

/** The effective mapping for every answer, review applied where one exists. */
export function resolveAllEffectiveMappings(
  mappings: readonly AnswerMapping[],
  reviews: readonly MappingReview[],
): EffectiveMapping[] {
  const reviewByAnswerId = new Map(reviews.map((review) => [review.answerId, review]));

  return mappings.map((mapping) =>
    resolveEffectiveMapping(mapping, reviewByAnswerId.get(mapping.answerId) ?? null),
  );
}

/**
 * Which answer currently holds a question, according to the effective
 * mappings. Used to detect a remap that would take a question already in use.
 */
export function findAnswerHoldingQuestion(
  questionId: string,
  mappings: readonly AnswerMapping[],
  reviews: readonly MappingReview[],
  excludeAnswerId?: string,
): string | null {
  for (const effective of resolveAllEffectiveMappings(mappings, reviews)) {
    if (effective.answerId === excludeAnswerId) continue;
    if (effective.questionId === questionId) return effective.answerId;
  }

  return null;
}
