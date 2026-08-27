import { NextResponse } from 'next/server';
import { toErrorResponse } from '@/lib/errors';
import { getAssessment } from '@/lib/services/assessment-service';
import { buildGradeItem, buildGradeHistory, summariseGrades } from '@/lib/services/grading';
import { AssessmentIdParamSchema } from '@/lib/validation';

export const runtime = 'nodejs';
export const dynamic = 'force-dynamic';

interface RouteContext {
  params: Promise<{ assessmentId: string }>;
}

/**
 * GET /api/assessments/:assessmentId/grades
 *
 * Every grade currently in force, plus the totals.
 *
 * Grades that were superseded — by a teacher remapping an answer, or by a
 * later run — are returned separately as `history` rather than mixed in.
 * Both matter, but only one counts, and a payload that blurred the two would
 * let a stale mark be added to a total.
 *
 * Marks that need a human are returned with their marks, not withheld:
 * `status` and `reviewReasons` say what still needs checking.
 */
export async function GET(_request: Request, context: RouteContext) {
  try {
    const { assessmentId } = AssessmentIdParamSchema.parse(await context.params);
    const assessment = await getAssessment(assessmentId);

    const grades = (assessment.grades ?? [])
      .filter((grade) => grade.isCurrent)
      .map((grade) => buildGradeItem(assessment, grade));

    return NextResponse.json({
      assessmentId,
      gradeCount: grades.length,
      // What still needs a human first: that is what this is opened for.
      grades: [...grades].sort((a, b) => rank(a.status) - rank(b.status)),
      history: buildGradeHistory(assessment.grades ?? []),
      summary: summariseGrades(assessment),
      // Rubrics that could not be tied to a question, with the reason. Kept
      // visible rather than dropped: a mark scheme nobody noticed was
      // unmatched is a silently unmarked question.
      unresolvedMarkSchemes: assessment.markSchemes?.unresolved ?? [],
      grading: assessment.grading ?? null,
    });
  } catch (error) {
    return toErrorResponse(error);
  }
}

function rank(status: string): number {
  switch (status) {
    case 'REVIEW_REQUIRED':
      return 0;
    case 'FAILED':
      return 1;
    case 'NOT_GRADEABLE':
      return 2;
    default:
      return 3;
  }
}
