import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { buildReviewItem, getReview } from '@/lib/services/review';
import { ReviewIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string; reviewId: string }>;
}

/** GET /api/assessments/:assessmentId/reviews/:reviewId */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId, reviewId } = ReviewIdParamSchema.parse(await context.params);

    // Looked up within the assessment, so a review belonging to another one
    // is not found rather than readable.
    const review = await getReview(assessmentId, reviewId);
    const assessment = await getAssessment(assessmentId);

    return NextResponse.json(buildReviewItem(assessment, review));
  } catch (error) {
    return toErrorResponse(error);
  }
}
