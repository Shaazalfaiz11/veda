import type { Assessment } from '@/lib/domain/assessment';
import type { AnswerMapping } from '@/lib/domain/mapping';
import { resolveEffectiveMapping, type MappingReview } from '@/lib/domain/review';

/**
 * Projections for the API.
 *
 * The future review screen needs the answer, the current mapping, the
 * confidence, the alternatives and the reasoning in one payload — otherwise
 * it renders a question id and a number, which is not something a teacher can
 * act on. Assembling that shape here keeps the presentation concern out of
 * the review service, which is about decisions rather than display.
 */

export interface ReviewItemView {
  reviewId: string;
  assessmentId: string;
  answerId: string;
  status: MappingReview['status'];
  trigger: MappingReview['trigger'];

  /** What the AI decided. Immutable. */
  aiMapping: {
    mappingId: string;
    questionId: string | null;
    status: AnswerMapping['status'];
    confidence: number;
    confidenceBand: AnswerMapping['confidenceBand'];
    reasonCodes: AnswerMapping['reasonCodes'];
    signals: AnswerMapping['signals'];
    verification: AnswerMapping['verification'];
  };

  /** What the teacher decided, if anything yet. */
  humanReview: {
    status: MappingReview['status'];
    action: string | null;
    questionId: string | null;
    reason: string | null;
    reviewerId: string | null;
    decidedAt: string | null;
  };

  /** What the system should act on now. */
  effectiveMapping: {
    questionId: string | null;
    source: 'AI' | 'HUMAN';
  };

  /** Enough of the answer to judge the mapping without a second request. */
  answer: {
    id: string;
    claimedLabelRaw: string | null;
    text: string;
    pageNumbers: number[];
    regions: unknown[];
  } | null;

  /** The alternatives the AI considered, best first. */
  candidates: Array<{
    questionId: string;
    questionLabelRaw: string;
    questionText: string | null;
    score: number;
    finalConfidence: number;
    signals: AnswerMapping['signals'];
  }>;

  createdAt: string;
  updatedAt: string;
}

export function buildReviewItem(
  assessment: Assessment,
  review: MappingReview,
): ReviewItemView {
  const mapping = assessment.mappings.find((entry) => entry.answerId === review.answerId);
  const answer = assessment.answers.find((entry) => entry.id === review.answerId) ?? null;
  const questionById = new Map(assessment.questions.map((q) => [q.id, q]));

  const effective = mapping
    ? resolveEffectiveMapping(mapping, review)
    : { questionId: null, source: 'AI' as const };

  return {
    reviewId: review.id,
    assessmentId: review.assessmentId,
    answerId: review.answerId,
    status: review.status,
    trigger: review.trigger,

    // Read from the review's own snapshot, not from the live mapping: this is
    // the decision the teacher is responding to.
    aiMapping: {
      mappingId: review.original.mappingId,
      questionId: review.original.questionId,
      status: review.original.status,
      confidence: review.original.confidence,
      confidenceBand: review.original.confidenceBand,
      reasonCodes: review.original.reasonCodes,
      signals: review.original.signals,
      verification: review.original.adjudication,
    },

    humanReview: {
      status: review.status,
      action: review.decision?.action ?? null,
      questionId: review.decision?.questionId ?? null,
      reason: review.decision?.reason ?? null,
      reviewerId: review.decision?.reviewerId ?? null,
      decidedAt: review.decision?.decidedAt ?? null,
    },

    effectiveMapping: {
      questionId: effective.questionId,
      source: effective.source,
    },

    answer: answer
      ? {
          id: answer.id,
          claimedLabelRaw: answer.claimedLabelRaw,
          text: answer.text,
          pageNumbers: answer.pageNumbers,
          regions: answer.regions,
        }
      : null,

    candidates: review.original.candidates.map((candidate) => ({
      questionId: candidate.questionId,
      questionLabelRaw: candidate.questionLabelRaw,
      questionText: questionById.get(candidate.questionId)?.text ?? null,
      score: candidate.candidateScore,
      finalConfidence: candidate.finalConfidence,
      signals: candidate.signals,
    })),

    createdAt: review.createdAt,
    updatedAt: review.updatedAt,
  };
}
