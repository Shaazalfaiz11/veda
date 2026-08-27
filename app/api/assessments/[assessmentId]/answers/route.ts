import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/answers
 *
 * The extracted answers, in reading order. Each carries what the student
 * wrote, the label they claimed, and where the writing sits — and no question
 * reference, because that decision has not been made yet.
 *
 * Extraction metadata is included for debugging; nothing about the request
 * that produced it is — no prompts, no page data, no keys.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    return NextResponse.json({
      assessmentId,
      answerCount: assessment.answers.length,
      answers: assessment.answers.map((answer) => ({
        id: answer.id,
        claimedLabelRaw: answer.claimedLabelRaw,
        claimedLabelNormalized: answer.claimedLabelNormalized,
        text: answer.text,
        regions: answer.regions,
        pageNumbers: answer.pageNumbers,
        spansPages: answer.spansPages,
        hasUncertainSegments: answer.hasUncertainSegments,
        containsDiagram: answer.containsDiagram,
        documentPosition: answer.documentPosition,
      })),
      extraction: assessment.answerExtraction
        ? {
            provider: assessment.answerExtraction.provider,
            model: assessment.answerExtraction.model,
            promptVersion: assessment.answerExtraction.promptVersion,
            extractedAt: assessment.answerExtraction.extractedAt,
            pagesProcessed: assessment.answerExtraction.pagesProcessed,
            answersExtracted: assessment.answerExtraction.answersExtracted,
            candidatesReceived: assessment.answerExtraction.candidatesReceived,
            candidatesRejected: assessment.answerExtraction.candidatesRejected,
            unlabelledCount: assessment.answerExtraction.unlabelledCount,
            warnings: assessment.answerExtraction.warnings,
            usage: assessment.answerExtraction.usage,
            // How the sheet was read, and whether all of it was. A partial
            // transcript must be visible to a caller — a teacher marking from
            // it needs to know pages are missing, not infer it from a
            // suspiciously short answer list.
            chunkCount: assessment.answerExtraction.chunkCount ?? null,
            duplicatesMerged: assessment.answerExtraction.duplicatesMerged ?? null,
            partial: assessment.answerExtraction.partial ?? false,
            failedChunks: assessment.answerExtraction.failedChunks ?? [],
          }
        : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
