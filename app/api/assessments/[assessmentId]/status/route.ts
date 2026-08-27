import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessmentStatus } from '@/lib/services/assessment-service';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/status
 *
 * The polling endpoint. Progress is derived from the stage rather than
 * stored, so it cannot drift out of step with the pipeline.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const status = await getAssessmentStatus(assessmentId);

    return NextResponse.json(status);
  } catch (error) {
    return toErrorResponse(error);
  }
}
