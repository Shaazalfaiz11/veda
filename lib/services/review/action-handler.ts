import { NextResponse } from 'next/server';
import { toErrorResponse, ValidationError } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import {
  INVALID_JSON,
  parseJsonBody,
  RemapActionSchema,
  ReviewActionSchema,
  ReviewIdParamSchema,
} from '@/lib/validation';
import { acceptReview, rejectReview, remapReview, skipReview } from './review-service';
import { buildReviewItem } from './review-view';
import type { ReviewerAction } from '@/lib/domain/review';

/**
 * One handler behind all four action endpoints.
 *
 * They differ only in which verb they record, so sharing the path means
 * validation, ownership checks and the response shape cannot drift apart
 * between them — and a fifth action later inherits all of it.
 */
export function reviewActionHandler(action: ReviewerAction) {
  return async function handle(
    request: Request,
    context: { params: Promise<{ assessmentId: string; reviewId: string }> },
  ): Promise<NextResponse> {
    try {
      const { assessmentId, reviewId } = ReviewIdParamSchema.parse(await context.params);

      const raw = await parseJsonBody(request);

      if (raw === INVALID_JSON) {
        throw new ValidationError('Request body must be valid JSON.');
      }

      // REMAP alone carries a target question, so it gets the stricter
      // schema; the rest share the common shape.
      const input = action === 'REMAP' ? RemapActionSchema.parse(raw) : null;
      const common = input ?? ReviewActionSchema.parse(raw);

      const outcome = await runAction(action, {
        assessmentId,
        reviewId,
        reviewerId: common.reviewerId ?? null,
        reason: common.reason ?? null,
        questionId: input?.questionId,
      });

      const assessment = await getAssessment(assessmentId);

      return NextResponse.json({
        ...buildReviewItem(assessment, outcome.review),
        // False when this repeated a decision already recorded — a
        // double-clicked button, not a second opinion.
        changed: outcome.changed,
      });
    } catch (error) {
      return toErrorResponse(error);
    }
  };
}

interface ActionArgs {
  assessmentId: string;
  reviewId: string;
  reviewerId: string | null;
  reason: string | null;
  questionId?: string;
}

function runAction(action: ReviewerAction, args: ActionArgs) {
  switch (action) {
    case 'ACCEPT':
      return acceptReview(args);
    case 'REJECT':
      return rejectReview(args);
    case 'SKIP':
      return skipReview(args);
    case 'REMAP':
      if (!args.questionId) {
        throw new ValidationError('REMAP requires a questionId.');
      }
      return remapReview({ ...args, questionId: args.questionId });
  }
}
