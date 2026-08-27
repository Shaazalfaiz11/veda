import { clamp01, NEUTRAL_SIGNAL } from '@/lib/domain/mapping';

/**
 * Positional support.
 *
 * Students usually work through a paper roughly in order, so an answer near
 * the top of the sheet is more likely to belong to an early question. That is
 * a tendency, not a rule — an out-of-order sheet is exactly the case this
 * system exists to handle.
 *
 * So position is scaled to be *supporting* evidence only. It carries the
 * smallest weight of the four signals and, crucially, never reaches 0: a
 * distant position weakens a pairing but can never veto a strong label or
 * semantic match on its own.
 */

/** How far from neutral a positional mismatch is allowed to push the score. */
const POSITION_INFLUENCE = 0.5;

export interface PositionInput {
  /** 0-based index of the answer in reading order. */
  answerIndex: number;
  answerCount: number;
  /** 0-based index of the question in printed order. */
  questionIndex: number;
  questionCount: number;
}

export function positionScore(input: PositionInput): number {
  const { answerIndex, answerCount, questionIndex, questionCount } = input;

  // A single item of either kind has no ordering to compare against.
  if (answerCount <= 1 || questionCount <= 1) return NEUTRAL_SIGNAL;

  const answerRelative = answerIndex / (answerCount - 1);
  const questionRelative = questionIndex / (questionCount - 1);

  const alignment = 1 - Math.abs(answerRelative - questionRelative);

  // Compress around the neutral point so this signal can support a match but
  // never decide one by itself. With an influence of 0.5 the score lives in
  // [0.25, 0.75]: a misaligned position weakens a pairing without ever being
  // able to veto a strong label or semantic match.
  return clamp01(NEUTRAL_SIGNAL + (alignment - NEUTRAL_SIGNAL) * POSITION_INFLUENCE);
}
