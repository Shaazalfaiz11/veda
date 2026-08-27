import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { progressFor } from '@/lib/domain/assessment';
import { toDocumentMetadata } from '@/lib/domain/document';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/** GET /api/assessments/:assessmentId — the full assessment record. */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    return NextResponse.json({
      assessmentId: assessment.id,
      status: assessment.status,
      stage: assessment.stage,
      progress: progressFor(assessment.status, assessment.stage),
      jobId: assessment.jobId,
      title: assessment.title,
      documents: assessment.documents.map(toDocumentMetadata),
      completedStages: assessment.completedStages,
      failure: assessment.failure,
      createdAt: assessment.createdAt,
      updatedAt: assessment.updatedAt,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
