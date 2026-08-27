import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { buildReviewItem, summariseReviews } from '@/lib/services/review';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/reviews
 *
 * Everything awaiting human attention, with the evidence needed to act on it:
 * the AI's decision, the teacher's decision if there is one, what is
 * currently in force, and the alternatives that were considered.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    const items = assessment.reviews.map((review) => buildReviewItem(assessment, review));

    return NextResponse.json({
      assessmentId,
      reviewCount: items.length,
      // Unresolved work first: that is what a reviewer opened this for.
      reviews: [...items].sort((a, b) => rank(a.status) - rank(b.status)),
      summary: summariseReviews(assessment),
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function rank(status: string): number {
  switch (status) {
    case 'PENDING':
      return 0;
    case 'IN_REVIEW':
      return 1;
    case 'SKIPPED':
      return 2;
    default:
      return 3;
  }
}
