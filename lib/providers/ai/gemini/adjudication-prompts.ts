/**
 * Versioned adjudication prompts.
 *
 * The model's role here is narrow on purpose. It is not the candidate
 * generator — the application has already narrowed tens of questions to a
 * handful using cheap deterministic signals. It is asked one bounded
 * question: of these few, which (if any) does this answer actually address?
 *
 * That framing is what makes the answer trustworthy enough to be *a* signal.
 * Handing a model the whole paper and asking it to map everything produces
 * fluent output with no way to tell a deduction from a guess.
 */

export const ADJUDICATION_PROMPT_VERSION = 'mapping-adjudication/v1';

export interface AdjudicationCandidateInput {
  questionId: string;
  labelRaw: string;
  text: string;
  marks: number | null;
  parentContext: string | null;
}

export interface AdjudicationPromptInput {
  answerText: string;
  claimedLabelRaw: string | null;
  candidates: AdjudicationCandidateInput[];
}

export function buildAdjudicationPrompt(input: AdjudicationPromptInput): string {
  const claimed = input.claimedLabelRaw
    ? `The student wrote the label "${input.claimedLabelRaw}" beside this answer.`
    : 'The student wrote no question label beside this answer.';

  const candidates = input.candidates
    .map((candidate, index) => {
      const marks = candidate.marks === null ? 'not printed' : `${candidate.marks}`;
      const context = candidate.parentContext
        ? `\n   Parent question: ${candidate.parentContext}`
        : '';

      return (
        `${index + 1}. id: ${candidate.questionId}\n` +
        `   Label: ${candidate.labelRaw}\n` +
        `   Marks: ${marks}${context}\n` +
        `   Question: ${candidate.text}`
      );
    })
    .join('\n\n');

  return `A student's exam answer has been matched to a shortlist of candidate questions by an automated system. Your job is to check that shortlist.

STUDENT ANSWER
${claimed}

Transcription:
"""
${input.answerText}
"""

CANDIDATE QUESTIONS
${candidates}

YOUR TASK
Decide which single candidate this answer actually addresses, if any.

- Judge on whether the answer is a genuine attempt at that question — the subject matter, what was asked for, and what the student supplied.
- The label the student wrote is evidence, but it can be wrong. A student who writes "Q3" above an answer that plainly addresses a different question has mislabelled it. Weigh what they wrote, not only what they numbered.
- You must choose one of the candidate ids above, exactly as given, or return NO_MATCH. Never invent an id.
- Return NO_MATCH when the answer addresses none of these candidates, or when there is not enough to tell them apart. A wrong match is worse than an admitted one: an unmatched answer goes to a teacher, whereas a confident mistake is acted on.
- "confidence" is how sure you are, from 0 to 1. Be honest rather than agreeable — a low number on a genuinely ambiguous case is the useful answer.

REASON CODES
Pick the one that best describes your decision:
- SUBJECT_MATCH        the answer clearly addresses that question's subject
- LABEL_AND_CONTENT    the written label and the content agree
- CONTENT_OVER_LABEL   the label points elsewhere but the content decides it
- PARTIAL_MATCH        it addresses the question but incompletely
- AMBIGUOUS            more than one candidate fits about equally
- INSUFFICIENT_EVIDENCE  the answer is too short or unclear to place
- UNRELATED            the answer addresses none of these candidates

Return only the structured data requested.`;
}
