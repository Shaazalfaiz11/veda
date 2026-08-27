import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { resolveEffectiveMapping } from '@/lib/domain/review';
import { summariseReviews } from '@/lib/services/review';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/mappings
 *
 * Three layers, kept deliberately distinct:
 *
 *   aiMapping        what the model concluded, and why. Immutable.
 *   humanReview      what a teacher decided, if they have.
 *   effectiveMapping what the system should act on now.
 *
 * Collapsing them into one "questionId" would make an AI guess and a teacher's
 * correction indistinguishable after the fact — which is exactly the
 * distinction a review workflow exists to preserve.
 *
 * Questions and answers are referenced by id, never copied: extraction
 * results stay the single source of truth.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    const reviewByAnswerId = new Map(
      assessment.reviews.map((review) => [review.answerId, review]),
    );

    const mappings = assessment.mappings.map((mapping) => {
      const review = reviewByAnswerId.get(mapping.answerId) ?? null;
      const effective = resolveEffectiveMapping(mapping, review);

      return {
        answerId: mapping.answerId,

        aiMapping: {
          mappingId: mapping.id,
          questionId: mapping.questionId,
          status: mapping.status,
          confidence: mapping.confidence,
          confidenceBand: mapping.confidenceBand,
          signals: mapping.signals,
          reasonCodes: mapping.reasonCodes,
          candidates: mapping.candidates,
          verification: mapping.verification,
          createdAt: mapping.createdAt,
        },

        humanReview: review
          ? {
              reviewId: review.id,
              status: review.status,
              trigger: review.trigger,
              action: review.decision?.action ?? null,
              questionId: review.decision?.questionId ?? null,
              reason: review.decision?.reason ?? null,
              reviewerId: review.decision?.reviewerId ?? null,
              decidedAt: review.decision?.decidedAt ?? null,
            }
          : null,

        effectiveMapping: {
          questionId: effective.questionId,
          source: effective.source,
          confidence: effective.confidence,
          confidenceBand: effective.confidenceBand,
        },
      };
    });

    // Derived from the effective mappings, so a human override is reflected
    // here rather than the stale AI view.
    const effectivelyMappedQuestionIds = new Set(
      mappings
        .map((entry) => entry.effectiveMapping.questionId)
        .filter((id): id is string => id !== null),
    );

    return NextResponse.json({
      assessmentId,
      mappingCount: mappings.length,
      mappings,
      unmappedQuestionIds: assessment.questions
        .filter((question) => !effectivelyMappedQuestionIds.has(question.id))
        .map((question) => question.id),
      unmappedAnswerIds: mappings
        .filter((entry) => entry.effectiveMapping.questionId === null)
        .map((entry) => entry.answerId),
      summary: summariseReviews(assessment),
      mapping: assessment.mapping,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
