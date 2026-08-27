import { createHash } from 'node:crypto';

/**
 * Mark schemes.
 *
 * A grade is only meaningful against a standard. Asking a model "is this
 * answer good?" produces a plausible number with nothing behind it; asking
 * "does this answer satisfy these criteria, worth these marks?" produces one
 * that can be checked line by line.
 *
 * Where the mark scheme comes from matters as much as what it says, so the
 * source is recorded and never obscured — an AI-generated rubric is a useful
 * scaffold, but it is not the same thing as the examiner's.
 */

export const MARK_SCHEME_SOURCES = [
  /** Extracted from a mark scheme document the teacher supplied. */
  'PROVIDED',
  /** Derived from the question text and its printed marks. Not authoritative. */
  'GENERATED',
  /** Nothing to grade against. */
  'UNAVAILABLE',
] as const;
export type MarkSchemeSource = (typeof MARK_SCHEME_SOURCES)[number];

/**
 * Marks policy.
 *
 * Whole marks by default, because most papers award them that way and a
 * "2.5" against a 2-mark question is a bug rather than a nuance. Half marks
 * are opt-in and explicit, so nothing can drift into fractional scoring by
 * accident.
 */
export const MARK_GRANULARITIES = ['WHOLE', 'HALF'] as const;
export type MarkGranularity = (typeof MARK_GRANULARITIES)[number];

export interface RubricCriterion {
  /** Stable within its mark scheme. The model may only cite these. */
  id: string;
  description: string;
  maxMarks: number;
  /** Concepts that earn the marks. Guidance for the grader, not a keyword list. */
  acceptableConcepts: string[];
  /** Whether marks can be split, or the criterion is all-or-nothing. */
  allowsPartialCredit: boolean;
}

export interface MarkScheme {
  /** Resolved against the extracted question set, never a raw label. */
  questionId: string;
  source: MarkSchemeSource;
  totalMarks: number;
  criteria: RubricCriterion[];
  /** An exemplar answer, where the mark scheme supplies one. */
  modelAnswer: string | null;
  granularity: MarkGranularity;
  /** Content hash, so a grade can be tied to the exact rubric that produced it. */
  version: string;
}

/**
 * A rubric the extractor could not tie to a question.
 *
 * Kept rather than dropped: a mark scheme naming "Q4" when no Q4 was
 * extracted is a signal that something upstream went wrong, and silently
 * discarding it would hide that.
 */
export interface UnresolvedMarkScheme {
  labelRaw: string;
  totalMarks: number | null;
  criteria: RubricCriterion[];
  reason: string;
}

export interface MarkSchemeSet {
  schemes: MarkScheme[];
  unresolved: UnresolvedMarkScheme[];
  source: MarkSchemeSource;
  extractedAt: string;
}

/**
 * Content hash of a mark scheme.
 *
 * Stored on every grade so a result can be traced to the exact rubric behind
 * it. If the rubric is later corrected, old grades remain attributable to the
 * version that produced them rather than appearing to have been made against
 * the new one.
 */
export function markSchemeVersion(
  questionId: string,
  totalMarks: number,
  criteria: readonly RubricCriterion[],
): string {
  const canonical = JSON.stringify({
    questionId,
    totalMarks,
    criteria: criteria
      .map((c) => ({ id: c.id, description: c.description.trim(), maxMarks: c.maxMarks }))
      .sort((a, b) => a.id.localeCompare(b.id)),
  });

  return createHash('sha256').update(canonical).digest('hex').slice(0, 16);
}

/** Whether a mark is legal under the granularity policy. */
export function isValidMarkValue(value: number, granularity: MarkGranularity): boolean {
  if (!Number.isFinite(value) || value < 0) return false;

  return granularity === 'WHOLE'
    ? Number.isInteger(value)
    : Number.isInteger(value * 2);
}

/** Rounds to the nearest legal mark. Only used when generating a rubric. */
export function roundToGranularity(value: number, granularity: MarkGranularity): number {
  return granularity === 'WHOLE' ? Math.round(value) : Math.round(value * 2) / 2;
}

/**
 * Builds a single-criterion rubric from a question that prints its marks.
 *
 * Deliberately marked GENERATED. It gives the grader a mark ceiling and the
 * question's own wording to judge against, which is far better than nothing —
 * but it invents no criteria the paper did not state, and it never claims the
 * authority of a real mark scheme.
 */
export function generateMarkSchemeFromQuestion(input: {
  questionId: string;
  questionText: string;
  marks: number;
  granularity?: MarkGranularity;
}): MarkScheme {
  const granularity = input.granularity ?? 'WHOLE';

  const criteria: RubricCriterion[] = [
    {
      id: 'overall',
      description: `A complete and correct response to: ${input.questionText}`,
      maxMarks: input.marks,
      acceptableConcepts: [],
      allowsPartialCredit: true,
    },
  ];

  return {
    questionId: input.questionId,
    source: 'GENERATED',
    totalMarks: input.marks,
    criteria,
    modelAnswer: null,
    granularity,
    version: markSchemeVersion(input.questionId, input.marks, criteria),
  };
}

/** Sum of the criterion ceilings. Should equal `totalMarks`. */
export function sumCriterionMaxMarks(criteria: readonly RubricCriterion[]): number {
  return criteria.reduce((total, criterion) => total + criterion.maxMarks, 0);
}
