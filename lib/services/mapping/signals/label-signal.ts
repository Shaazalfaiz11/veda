import { parseQuestionLabel } from '@/lib/domain/question';
import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';
import { LABEL_MATCH_SCORES, type LabelMatchKind } from '@/lib/domain/mapping';

/**
 * Label matching.
 *
 * The strongest deterministic evidence available, when the student wrote a
 * label at all. Every outcome is a named kind with a fixed score, so the rule
 * that produced a mapping can be read off the result rather than inferred
 * from a number.
 *
 * The case that needs care is the bare "(a)". A student writing "(a)" has
 * told us their answer is *a* sub-part, not *which* question's sub-part —
 * and a paper may have an "(a)" under question 6 and another under 11. That
 * scores as SUBPART_ONLY for every candidate equally, leaving position and
 * semantics to break the tie. Treating it as a match for the first "(a)" in
 * the document would be a guess wearing the clothes of a deduction.
 */

export interface LabelSignal {
  kind: LabelMatchKind;
  score: number;
}

export function scoreLabelMatch(answer: Answer, question: Question): LabelSignal {
  const kind = classifyLabelMatch(answer, question);
  return { kind, score: LABEL_MATCH_SCORES[kind] };
}

export function classifyLabelMatch(answer: Answer, question: Question): LabelMatchKind {
  const claimed = answer.claimedLabelRaw;

  // No label written: no evidence in either direction.
  if (!claimed) return 'NO_LABEL';

  const parsed = parseQuestionLabel(claimed);
  const answerNormalized = answer.claimedLabelNormalized ?? parsed.normalizedLabel;

  // Identical canonical form. The two sides normalise the same way by
  // construction, so "Q4", "4." and "Question 4" all land here.
  if (answerNormalized === question.normalizedLabel) {
    return question.isSubQuestion
      ? 'EXACT_PARENT_AND_SUBQUESTION'
      : 'EXACT_NORMALIZED_LABEL';
  }

  const answerMajor = parsed.sortKey.major;
  const answerSub = parsed.sortKey.minor ?? parsed.sortKey.roman;
  const questionMajor = question.sortKey.major;
  const questionSub = question.sortKey.minor ?? question.sortKey.roman;

  // A bare "(a)" with no owning number. It matches any question carrying the
  // same sub-part, and equally — which is exactly what it tells us.
  if (parsed.isOrphanSubPart) {
    if (questionSub !== null && answerSub === questionSub) return 'SUBPART_ONLY';
    return 'CONFLICTING_LABEL';
  }

  if (answerMajor > 0 && answerMajor === questionMajor) {
    if (answerSub !== null && questionSub !== null) {
      return answerSub === questionSub ? 'PARENT_MATCH_SUBPART_MATCH' : 'CONFLICTING_LABEL';
    }

    // Same number, but one side names a sub-part and the other does not:
    // the right question, an unclear part.
    return 'PARENT_ONLY';
  }

  // Both sides carry a label and the numbers disagree.
  return 'CONFLICTING_LABEL';
}
