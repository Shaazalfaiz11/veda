/**
 * Versioned grading prompts.
 *
 * The model is asked to do one bounded thing: judge one answer against one
 * question and one rubric, criterion by criterion. It is not asked whether
 * the answer is "good" — that question has no checkable answer and produces a
 * fluent number with nothing behind it.
 *
 * Two instructions carry most of the weight. Mark against the criteria, not
 * against a private idea of a good answer. And distinguish *missing* from
 * *wrong*: a student who omitted a point has not earned that mark, but a
 * student who stated something incorrect may have lost others too, and a
 * grader that conflates them writes feedback the student cannot act on.
 */

export const GRADING_PROMPT_VERSION = 'grading/v1';

export interface GradingCriterionInput {
  id: string;
  description: string;
  maxMarks: number;
  acceptableConcepts: string[];
  allowsPartialCredit: boolean;
}

export interface GradingPromptInput {
  questionLabel: string;
  questionText: string;
  parentContext: string | null;
  totalMarks: number;
  granularity: 'WHOLE' | 'HALF';

  answerText: string;
  answerHasUncertainSegments: boolean;
  answerContainsDiagram: boolean;

  criteria: GradingCriterionInput[];
  modelAnswer: string | null;
  rubricIsGenerated: boolean;
}

export function buildGradingPrompt(input: GradingPromptInput): string {
  const criteria = input.criteria
    .map((criterion, index) => {
      const concepts =
        criterion.acceptableConcepts.length > 0
          ? `\n   Credit-worthy points: ${criterion.acceptableConcepts.join('; ')}`
          : '';
      const partial = criterion.allowsPartialCredit
        ? 'partial marks allowed'
        : 'all-or-nothing';

      return (
        `${index + 1}. id: ${criterion.id}\n` +
        `   Worth: ${criterion.maxMarks} mark${criterion.maxMarks === 1 ? '' : 's'} (${partial})\n` +
        `   Criterion: ${criterion.description}${concepts}`
      );
    })
    .join('\n\n');

  const marksNote =
    input.granularity === 'WHOLE'
      ? 'Award whole marks only. Never a fraction.'
      : 'Award whole or half marks only (e.g. 0, 0.5, 1). No other fractions.';

  const rubricNote = input.rubricIsGenerated
    ? '\nNote: this rubric was derived from the question and its printed mark allocation, not from an official mark scheme. Judge the answer on its merits against the question.'
    : '';

  const uncertainNote = input.answerHasUncertainSegments
    ? '\nThe transcription contains "[unclear]" where the handwriting could not be read. Do not treat an unreadable stretch as a wrong or missing answer — judge only what is legible, and say in your reasoning where illegibility limited what you could assess.'
    : '';

  const diagramNote = input.answerContainsDiagram
    ? '\nThe answer includes a hand-drawn diagram. You are given a text description of it, not the drawing. Credit what the description supports, and do not assume detail it does not mention.'
    : '';

  const parent = input.parentContext
    ? `\nParent question (for context): ${input.parentContext}`
    : '';

  return `You are marking one exam answer against its mark scheme.

QUESTION ${input.questionLabel}
Worth ${input.totalMarks} mark${input.totalMarks === 1 ? '' : 's'} in total.${parent}

"""
${input.questionText}
"""

STUDENT ANSWER${uncertainNote}${diagramNote}

"""
${input.answerText}
"""
${
  input.modelAnswer
    ? `\nMODEL ANSWER (for reference — the student need not match it word for word)\n"""\n${input.modelAnswer}\n"""\n`
    : ''
}
MARK SCHEME${rubricNote}

${criteria}

HOW TO MARK
- Judge each criterion separately, against what the student actually wrote.
- Award marks for what is there. Do not deduct for things the criterion does not ask about, and do not reward correct material the criterion does not cover.
- ${marksNote}
- Never award more than a criterion is worth.
- Where a criterion allows partial marks, use them: an answer that makes one of two required points earns one of two marks.
- Distinguish clearly between an answer that is *missing* a point and one that states something *incorrect*. Both may score zero on that criterion, but they need different feedback.
- Do not invent content the student did not write, and do not assume they meant something they did not say.
- If a criterion genuinely cannot be judged from what you were given, award 0 and say so plainly in the reason rather than guessing.

WHAT TO RETURN
- One entry per criterion, citing the criterion id exactly as given above. Do not invent ids and do not omit any.
- "awardedMarks" for each criterion, within its maximum.
- "reason": one or two sentences on why those marks, referring to what the student wrote.
- "totalAwardedMarks": the sum of your criterion marks. It must add up exactly.
- "confidence": how sure you are of this marking, from 0 to 1. Be honest — a low number on a genuinely difficult answer is the useful response.
- "feedback": two or three sentences addressed to the student, saying what they did well and what was missing. Be specific and constructive; do not restate the marks.

Return only the structured data requested.`;
}
