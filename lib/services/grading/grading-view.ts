import type { Assessment } from '@/lib/domain/assessment';
import type { GradingResult, GradingSummary } from '@/lib/domain/grading';

/**
 * Projections for the API.
 *
 * A grade on its own is a number and a status. What makes it reviewable is
 * the rest: which question it was measured against, which rubric, what the
 * student actually wrote, and which criteria carried the marks. Assembling
 * that here keeps display concerns out of the grading service, which is about
 * marking rather than presentation.
 *
 * Two things are deliberately never flattened. A grade made against a rubric
 * the system generated is labelled as such, so nobody mistakes it for the
 * examiner's. And superseded grades stay visible as history rather than
 * disappearing, because "this was marked as Q4 before a teacher moved it to
 * Q5" is exactly what someone auditing a mark needs to see.
 */

export interface GradeItemView {
  gradeId: string;
  answerId: string;
  questionId: string | null;

  status: GradingResult['status'];
  awardedMarks: number | null;
  maximumMarks: number | null;

  criteria: GradingResult['criteria'];
  confidence: number;
  confidenceFactors: GradingResult['confidenceFactors'];
  feedback: string;

  notGradeableReason: GradingResult['notGradeableReason'];
  reviewReasons: GradingResult['reviewReasons'];

  /** Where the marks came from, so a derived rubric is never mistaken for one. */
  markScheme: {
    source: string;
    version: string;
    totalMarks: number;
    criteriaCount: number;
  } | null;

  /** Enough of the question to read the grade without a second request. */
  question: {
    id: string;
    labelRaw: string;
    text: string;
    marks: number | null;
  } | null;

  /** Enough of the answer to judge the marks. */
  answer: {
    id: string;
    claimedLabelRaw: string | null;
    text: string;
    hasUncertainSegments: boolean;
    containsDiagram: boolean;
    pageNumbers: number[];
  } | null;

  /** How the answer came to be attached to this question. */
  mappingSource: 'AI' | 'HUMAN' | null;

  metadata: GradingResult['metadata'];
  gradedAt: string;
}

/** A grade this one replaced, kept for the audit trail. */
export interface GradeHistoryView {
  gradeId: string;
  questionId: string | null;
  status: GradingResult['status'];
  awardedMarks: number | null;
  maximumMarks: number | null;
  supersededReason: string | null;
  gradedAt: string;
}

export function buildGradeItem(assessment: Assessment, grade: GradingResult): GradeItemView {
  const question = grade.questionId
    ? assessment.questions.find((q) => q.id === grade.questionId) ?? null
    : null;
  const answer = assessment.answers.find((a) => a.id === grade.answerId) ?? null;

  const scheme = grade.questionId
    ? assessment.markSchemes?.schemes.find((s) => s.questionId === grade.questionId) ?? null
    : null;

  const review = (assessment.reviews ?? []).find((r) => r.answerId === grade.answerId);

  return {
    gradeId: grade.id,
    answerId: grade.answerId,
    questionId: grade.questionId,

    status: grade.status,
    awardedMarks: grade.awardedMarks,
    maximumMarks: grade.maximumMarks,

    criteria: grade.criteria,
    confidence: grade.confidence,
    confidenceFactors: grade.confidenceFactors,
    feedback: grade.feedback,

    notGradeableReason: grade.notGradeableReason,
    reviewReasons: grade.reviewReasons,

    markScheme: scheme
      ? {
          source: scheme.source,
          version: scheme.version,
          totalMarks: scheme.totalMarks,
          criteriaCount: scheme.criteria.length,
        }
      : null,

    question: question
      ? {
          id: question.id,
          labelRaw: question.labelRaw,
          text: question.text,
          marks: question.marks,
        }
      : null,

    answer: answer
      ? {
          id: answer.id,
          claimedLabelRaw: answer.claimedLabelRaw,
          text: answer.text,
          hasUncertainSegments: answer.hasUncertainSegments,
          containsDiagram: answer.containsDiagram,
          pageNumbers: [...new Set(answer.regions.map((region) => region.pageNumber))].sort(
            (a, b) => a - b,
          ),
        }
      : null,

    mappingSource: review?.decision ? 'HUMAN' : grade.questionId ? 'AI' : null,

    metadata: grade.metadata,
    gradedAt: grade.createdAt,
  };
}

export function buildGradeHistory(grades: readonly GradingResult[]): GradeHistoryView[] {
  return grades
    .filter((grade) => !grade.isCurrent)
    .map((grade) => ({
      gradeId: grade.id,
      questionId: grade.questionId,
      status: grade.status,
      awardedMarks: grade.awardedMarks,
      maximumMarks: grade.maximumMarks,
      supersededReason: grade.supersededReason,
      gradedAt: grade.createdAt,
    }))
    .sort((a, b) => b.gradedAt.localeCompare(a.gradedAt));
}

/**
 * The totals.
 *
 * Counted over current grades only, so a superseded grade never contributes
 * marks twice. `availableMarks` is the marks actually attempted and graded,
 * not the whole paper — dividing by the paper total would report a student
 * who answered half the questions as having scored half of what they earned.
 * The marks nobody accounted for are reported separately, as
 * `ungradedMarks`, rather than being folded into the percentage.
 */
export function summariseGrades(assessment: Assessment): GradingSummary {
  const current = (assessment.grades ?? []).filter((grade) => grade.isCurrent);

  const scored = current.filter(
    (grade) => grade.awardedMarks !== null && grade.maximumMarks !== null,
  );

  const awardedMarks = scored.reduce((total, grade) => total + (grade.awardedMarks ?? 0), 0);
  const availableMarks = scored.reduce((total, grade) => total + (grade.maximumMarks ?? 0), 0);

  const gradedQuestionIds = new Set(
    scored.map((grade) => grade.questionId).filter((id): id is string => id !== null),
  );

  // Marks on the paper that no graded answer accounted for: unanswered
  // questions, rejected mappings, and anything that failed to grade.
  const ungradedMarks = (assessment.markSchemes?.schemes ?? [])
    .filter((scheme) => !gradedQuestionIds.has(scheme.questionId))
    .reduce((total, scheme) => total + scheme.totalMarks, 0);

  return {
    totalAnswers: current.length,
    graded: current.filter((grade) => grade.status === 'GRADED').length,
    reviewRequired: current.filter((grade) => grade.status === 'REVIEW_REQUIRED').length,
    notGradeable: current.filter((grade) => grade.status === 'NOT_GRADEABLE').length,
    failed: current.filter((grade) => grade.status === 'FAILED').length,

    awardedMarks,
    availableMarks,
    percentage:
      availableMarks > 0 ? Math.round((awardedMarks / availableMarks) * 1000) / 10 : null,

    ungradedMarks,
  };
}
