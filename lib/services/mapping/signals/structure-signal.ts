import { clamp01, NEUTRAL_SIGNAL } from '@/lib/domain/mapping';
import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';

/**
 * Structural compatibility.
 *
 * Three weak, independent checks on whether an answer has the *shape* the
 * question asks for. Each returns neutral when it has nothing to say, and the
 * signal is their mean — so a question that neither asks for a diagram nor
 * prints marks contributes nothing rather than noise.
 *
 * Deliberately kept weak. A question asking for a diagram is *somewhat* more
 * likely to be answered by writing that contains one, but plenty of students
 * answer a diagram question in prose, and plenty draw where nothing was
 * asked. Letting this decide a mapping would overfit the tidy case and
 * mis-handle the messy one.
 */

/** Words that indicate the question expects something drawn. */
const DIAGRAM_REQUEST = /\b(draw|sketch|diagram|label(?:led|led diagram)?|illustrate|plot)\b/i;

/** Roughly how many characters of writing a mark is worth. */
const CHARS_PER_MARK = 90;

export function expectsDiagram(question: Question): boolean {
  return DIAGRAM_REQUEST.test(question.text);
}

/**
 * A drawn answer to a "draw" question supports the pairing; prose where a
 * diagram was asked for weakens it slightly. A diagram where none was asked
 * is not held against the answer — students annotate freely.
 */
export function diagramCompatibility(answer: Answer, question: Question): number {
  const asked = expectsDiagram(question);

  if (asked && answer.containsDiagram) return 0.9;
  if (asked && !answer.containsDiagram) return 0.35;
  return NEUTRAL_SIGNAL;
}

/**
 * Length against the printed mark allocation. A 5-mark question answered in
 * four words, or a 1-mark question answered in three paragraphs, is mildly
 * suspicious. Only mildly: verbosity is not evidence.
 */
export function lengthCompatibility(answer: Answer, question: Question): number {
  if (question.marks === null || question.marks <= 0) return NEUTRAL_SIGNAL;

  const expected = question.marks * CHARS_PER_MARK;
  const actual = answer.text.length;

  if (actual === 0) return NEUTRAL_SIGNAL;

  // Ratio folded so that "twice as long" and "half as long" score alike.
  const ratio = actual > expected ? expected / actual : actual / expected;

  // Never drops below 0.35: length is the weakest evidence here.
  return clamp01(0.35 + ratio * 0.55);
}

/**
 * Whether both sides agree about being a sub-part. An answer the student
 * labelled "(b)" pairs more naturally with a sub-question than with a
 * top-level one.
 */
export function subQuestionCompatibility(answer: Answer, question: Question): number {
  if (answer.claimedLabelRaw === null) return NEUTRAL_SIGNAL;

  const answerLooksSub = /\(?[a-z]\)|\((?:i|ii|iii|iv|v|vi|vii|viii|ix|x)\)/i.test(
    answer.claimedLabelRaw,
  );

  if (answerLooksSub === question.isSubQuestion) return 0.75;
  return 0.4;
}

export function structureScore(answer: Answer, question: Question): number {
  const parts = [
    diagramCompatibility(answer, question),
    lengthCompatibility(answer, question),
    subQuestionCompatibility(answer, question),
  ];

  return clamp01(parts.reduce((total, part) => total + part, 0) / parts.length);
}
