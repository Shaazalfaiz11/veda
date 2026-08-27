import { NextResponse } from 'next/server';
import { ZodError } from 'zod';
import { toErrorResponse } from '@/lib/errors';
import { createAssessment } from '@/lib/services/assessment-service';
import {
  CreateAssessmentSchema,
  INVALID_JSON,
  parseJsonBody,
} from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

/** POST /api/assessments — create an assessment in CREATED. */
export async function POST(request: Request) {
  try {
    const raw = await parseJsonBody(request);

    if (raw === INVALID_JSON) {
      return NextResponse.json(
        { error: { code: 'VALIDATION_ERROR', message: 'Request body must be valid JSON.' } },
        { status: 400 },
      );
    }

    const body = CreateAssessmentSchema.parse(raw);

    const assessment = await createAssessment({ title: body.title ?? null });

    return NextResponse.json(
      {
        assessmentId: assessment.id,
        status: assessment.status,
        title: assessment.title,
        documents: [],
        createdAt: assessment.createdAt,
      },
      { status: 201 },
    );
  } catch (error) {
    if (error instanceof ZodError) return toErrorResponse(error);
    return toErrorResponse(error);
  }
}
