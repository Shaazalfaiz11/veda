import { NextResponse } from 'next/server';
import { NotFoundError, toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { buildGradeItem } from '@/lib/services/grading';
import { QuestionIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string; questionId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/grades/:questionId
 *
 * One question's grade, with the criterion-by-criterion breakdown, the rubric
 * it was measured against and the answer it was measured from.
 *
 * The question is resolved inside the loaded assessment rather than looked up
 * globally, so a well-formed id belonging to another assessment reads as not
 * found here — the same rule the review routes follow.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId, questionId } = QuestionIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    const question = assessment.questions.find((entry) => entry.id === questionId);

    if (!question) {
      throw new NotFoundError(`Question ${questionId} is not part of assessment ${assessmentId}.`);
    }

    const all = assessment.grades ?? [];
    const current = all.find((grade) => grade.isCurrent && grade.questionId === questionId) ?? null;

    // Grades this question has held before, including ones an answer took
    // with it when a teacher remapped it elsewhere.
    const history = all
      .filter((grade) => !grade.isCurrent && grade.questionId === questionId)
      .map((grade) => ({
        gradeId: grade.id,
        answerId: grade.answerId,
        status: grade.status,
        awardedMarks: grade.awardedMarks,
        maximumMarks: grade.maximumMarks,
        supersededReason: grade.supersededReason,
        gradedAt: grade.createdAt,
      }))
      .sort((a, b) => b.gradedAt.localeCompare(a.gradedAt));

    return NextResponse.json({
      assessmentId,
      questionId,
      question: {
        id: question.id,
        labelRaw: question.labelRaw,
        text: question.text,
        marks: question.marks,
      },
      // Null rather than an error: a question nobody answered is a normal
      // outcome, and saying so is more useful than a 404.
      grade: current ? buildGradeItem(assessment, current) : null,
      markScheme:
        assessment.markSchemes?.schemes.find((scheme) => scheme.questionId === questionId) ?? null,
      history,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}
