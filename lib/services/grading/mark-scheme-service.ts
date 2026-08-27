import type { Question } from '@/lib/domain/question';
import {
  generateMarkSchemeFromQuestion,
  markSchemeVersion,
  sumCriterionMaxMarks,
  type MarkScheme,
  type MarkSchemeSet,
  type MarkGranularity,
  type RubricCriterion,
  type UnresolvedMarkScheme,
} from '@/lib/domain/grading';
import { parseQuestionLabel } from '@/lib/domain/question';
import { ValidationError } from '@/lib/errors';

/**
 * Where a mark scheme comes from.
 *
 * Three sources, in descending order of authority:
 *
 *   PROVIDED     extracted from a mark scheme the teacher supplied
 *   GENERATED    derived from the question's own printed marks
 *   UNAVAILABLE  nothing to grade against
 *
 * The distinction is preserved everywhere rather than flattened, because a
 * grade made against a rubric we invented is a different claim from one made
 * against the examiner's. Presenting them identically would be the single
 * most misleading thing this phase could do.
 */

export interface ResolveMarkSchemesInput {
  questions: readonly Question[];
  /** Rubrics extracted from a supplied mark scheme document, if any. */
  provided?: readonly ProvidedMarkScheme[];
  granularity?: MarkGranularity;
}

/** A rubric as extracted, still carrying a raw label rather than a question id. */
export interface ProvidedMarkScheme {
  labelRaw: string;
  totalMarks: number | null;
  criteria: RubricCriterion[];
  modelAnswer?: string | null;
}

/**
 * Ties rubrics to questions and fills the gaps.
 *
 * Association is by normalised label against the extracted question set —
 * the same normalisation both sides of the mapper use, so "Q4", "4." and
 * "Question 4" all reach the same question. A rubric that matches nothing, or
 * matches more than one, is recorded as unresolved rather than attached to a
 * best guess: a mark scheme applied to the wrong question would mark a
 * correct answer wrong, which is worse than not marking it at all.
 */
export function resolveMarkSchemes(input: ResolveMarkSchemesInput): MarkSchemeSet {
  const granularity = input.granularity ?? 'WHOLE';
  const provided = input.provided ?? [];

  const schemes: MarkScheme[] = [];
  const unresolved: UnresolvedMarkScheme[] = [];
  const claimed = new Set<string>();

  for (const candidate of provided) {
    const normalized = parseQuestionLabel(candidate.labelRaw).normalizedLabel;
    const matches = input.questions.filter((q) => q.normalizedLabel === normalized);

    if (matches.length === 0) {
      unresolved.push({
        labelRaw: candidate.labelRaw,
        totalMarks: candidate.totalMarks,
        criteria: candidate.criteria,
        reason: `No extracted question matches label "${candidate.labelRaw}".`,
      });
      continue;
    }

    if (matches.length > 1) {
      unresolved.push({
        labelRaw: candidate.labelRaw,
        totalMarks: candidate.totalMarks,
        criteria: candidate.criteria,
        reason: `Label "${candidate.labelRaw}" matches ${matches.length} questions; the association is ambiguous.`,
      });
      continue;
    }

    const question = matches[0]!;

    if (claimed.has(question.id)) {
      unresolved.push({
        labelRaw: candidate.labelRaw,
        totalMarks: candidate.totalMarks,
        criteria: candidate.criteria,
        reason: `Question "${question.labelRaw}" already has a mark scheme.`,
      });
      continue;
    }

    const scheme = buildProvidedScheme(question, candidate, granularity);

    if ('reason' in scheme) {
      unresolved.push({
        labelRaw: candidate.labelRaw,
        totalMarks: candidate.totalMarks,
        criteria: candidate.criteria,
        reason: scheme.reason,
      });
      continue;
    }

    claimed.add(question.id);
    schemes.push(scheme.scheme);
  }

  // Questions with no supplied rubric fall back to their own printed marks.
  // A question with no marks printed gets nothing at all — inventing a mark
  // total would be fabricating the thing being measured.
  for (const question of input.questions) {
    if (claimed.has(question.id)) continue;
    if (question.marks === null || question.marks <= 0) continue;

    schemes.push(
      generateMarkSchemeFromQuestion({
        questionId: question.id,
        questionText: question.text,
        marks: question.marks,
        granularity,
      }),
    );
  }

  return {
    schemes,
    unresolved,
    source: provided.length > 0 ? 'PROVIDED' : 'GENERATED',
    extractedAt: new Date().toISOString(),
  };
}

/**
 * Validates a supplied rubric before it is trusted to mark anything.
 *
 * The check that matters is that the criteria add up to the stated total. A
 * rubric whose parts sum to 6 while claiming to be worth 5 is internally
 * broken, and any mark derived from it would be arbitrary.
 */
function buildProvidedScheme(
  question: Question,
  candidate: ProvidedMarkScheme,
  granularity: MarkGranularity,
): { scheme: MarkScheme } | { reason: string } {
  if (candidate.criteria.length === 0) {
    return { reason: `Mark scheme for "${candidate.labelRaw}" has no criteria.` };
  }

  for (const criterion of candidate.criteria) {
    if (!Number.isFinite(criterion.maxMarks) || criterion.maxMarks <= 0) {
      return {
        reason: `Criterion "${criterion.id}" has an invalid mark allocation.`,
      };
    }
  }

  const criteriaTotal = sumCriterionMaxMarks(candidate.criteria);

  // The printed marks on the question win where both exist: the paper the
  // student sat is the authority on what the question was worth.
  const totalMarks = question.marks ?? candidate.totalMarks ?? criteriaTotal;

  if (Math.abs(criteriaTotal - totalMarks) > 1e-6) {
    return {
      reason:
        `Mark scheme for "${candidate.labelRaw}" is inconsistent: criteria total ` +
        `${criteriaTotal} but the question is worth ${totalMarks}.`,
    };
  }

  return {
    scheme: {
      questionId: question.id,
      source: 'PROVIDED',
      totalMarks,
      criteria: candidate.criteria,
      modelAnswer: candidate.modelAnswer ?? null,
      granularity,
      version: markSchemeVersion(question.id, totalMarks, candidate.criteria),
    },
  };
}

/** The scheme for one question, or null when there is none. */
export function findMarkScheme(
  set: MarkSchemeSet | null,
  questionId: string,
): MarkScheme | null {
  return set?.schemes.find((scheme) => scheme.questionId === questionId) ?? null;
}

/** Guards a rubric before it is used, so a broken one fails loudly. */
export function assertUsableMarkScheme(scheme: MarkScheme): void {
  if (scheme.criteria.length === 0) {
    throw new ValidationError(
      `Mark scheme for question ${scheme.questionId} has no criteria.`,
    );
  }

  const criteriaTotal = sumCriterionMaxMarks(scheme.criteria);

  if (Math.abs(criteriaTotal - scheme.totalMarks) > 1e-6) {
    throw new ValidationError(
      `Mark scheme for question ${scheme.questionId} is inconsistent: criteria total ` +
        `${criteriaTotal} but the total is ${scheme.totalMarks}.`,
      { criteriaTotal, totalMarks: scheme.totalMarks },
    );
  }

  const ids = scheme.criteria.map((c) => c.id);

  if (new Set(ids).size !== ids.length) {
    throw new ValidationError(
      `Mark scheme for question ${scheme.questionId} has duplicate criterion ids.`,
    );
  }
}
