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
 * GET /api/assessments/:assessmentId/questions
 *
 * The extracted questions, in deterministic order. Extraction metadata is
 * included for debugging — provider, model and prompt version — but nothing
 * about the request that produced them: no prompts, no page data, no keys.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    return NextResponse.json({
      assessmentId,
      questionCount: assessment.questions.length,
      questions: assessment.questions.map((question) => ({
        id: question.id,
        labelRaw: question.labelRaw,
        normalizedLabel: question.normalizedLabel,
        parentLabel: question.parentLabel,
        isSubQuestion: question.isSubQuestion,
        text: question.text,
        marks: question.marks,
        pageNumber: question.pageNumber,
        pageNumbers: question.pageNumbers,
        rects: question.rects,
      })),
      extraction: assessment.questionExtraction
        ? {
            provider: assessment.questionExtraction.provider,
            model: assessment.questionExtraction.model,
            promptVersion: assessment.questionExtraction.promptVersion,
            extractedAt: assessment.questionExtraction.extractedAt,
            pagesProcessed: assessment.questionExtraction.pagesProcessed,
            questionsExtracted: assessment.questionExtraction.questionsExtracted,
            candidatesReceived: assessment.questionExtraction.candidatesReceived,
            candidatesRejected: assessment.questionExtraction.candidatesRejected,
            warnings: assessment.questionExtraction.warnings,
            usage: assessment.questionExtraction.usage,
          }
        : null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
