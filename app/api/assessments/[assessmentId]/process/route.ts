import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { requestProcessing } from '@/lib/services/assessment-service';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * POST /api/assessments/:assessmentId/process
 *
 * Enqueues a processing job and returns immediately. No AI work happens on
 * this request path — the response is 202 precisely because the work has
 * been accepted, not performed.
 */
export async function POST(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const ticket = await requestProcessing(assessmentId);

    return NextResponse.json(ticket, { status: 202 });
  } catch (error) {
    return toErrorResponse(error);
  }
}
