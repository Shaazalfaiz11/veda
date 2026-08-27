import { getEnv } from '@/lib/config';
import type { Answer } from '@/lib/domain/answer';
import type { Question } from '@/lib/domain/question';
import {
  calculateCandidateScore,
  type MappingCandidate,
  type MappingSignals,
} from '@/lib/domain/mapping';
import {
  cosineSimilarity,
  positionScore,
  scoreLabelMatch,
  semanticScore,
  structureScore,
} from './signals';

/**
 * Candidate generation.
 *
 * Every answer is scored against every question using four cheap,
 * deterministic signals, and only the best few go on to the adjudicator. That
 * ordering is the point of the whole design: a full comparison is free, an
 * LLM call is not, and narrowing the field first means the model is asked a
 * question it can actually answer instead of being handed a paper and a hope.
 *
 * Nothing here decides anything. It produces a ranked shortlist with the
 * reasoning attached, and the losing candidates are kept so a mapping can be
 * reviewed rather than merely believed.
 */

export interface EmbeddedQuestion {
  question: Question;
  vector: number[];
  /** Printed order, used by the positional signal. */
  index: number;
}

export interface EmbeddedAnswer {
  answer: Answer;
  vector: number[];
  /** Reading order on the sheet, used by the positional signal. */
  index: number;
}

export interface CandidateSet {
  answerId: string;
  /** Best first, limited to top K. */
  candidates: MappingCandidate[];
  /** Every pair's score, kept so global assignment can see beyond the top K. */
  scoreByQuestionId: Map<string, number>;
  signalsByQuestionId: Map<string, MappingSignals>;
}

/**
 * Scores one answer against every question and returns the top K.
 *
 * The semantic signal is rescaled against the spread of *this answer's*
 * cosines, so it reflects which question stands out rather than the absolute
 * similarity floor of the subject matter.
 */
export function generateCandidates(
  embeddedAnswer: EmbeddedAnswer,
  embeddedQuestions: readonly EmbeddedQuestion[],
  options: { topK?: number; answerCount?: number } = {},
): CandidateSet {
  const env = getEnv();
  const topK = options.topK ?? env.MAPPING_TOP_K;

  const { answer, vector: answerVector, index: answerIndex } = embeddedAnswer;

  const cosines = embeddedQuestions.map((entry) =>
    cosineSimilarity(answerVector, entry.vector),
  );

  const scored: MappingCandidate[] = embeddedQuestions.map((entry, position) => {
    const cosine = cosines[position] ?? 0;
    const label = scoreLabelMatch(answer, entry.question);

    const signals: MappingSignals = {
      label: label.score,
      labelKind: label.kind,
      semantic: semanticScore(cosine, cosines),
      semanticCosine: cosine,
      position: positionScore({
        answerIndex,
        answerCount: options.answerCount ?? 1,
        questionIndex: entry.index,
        questionCount: embeddedQuestions.length,
      }),
      structure: structureScore(answer, entry.question),
    };

    return {
      questionId: entry.question.id,
      questionLabelRaw: entry.question.labelRaw,
      signals,
      candidateScore: calculateCandidateScore(signals),
      llmSelected: false,
      llmConfidence: null,
      finalConfidence: 0,
    };
  });

  const scoreByQuestionId = new Map<string, number>();
  const signalsByQuestionId = new Map<string, MappingSignals>();

  for (const candidate of scored) {
    scoreByQuestionId.set(candidate.questionId, candidate.candidateScore);
    signalsByQuestionId.set(candidate.questionId, candidate.signals);
  }

  scored.sort(compareCandidates);

  return {
    answerId: answer.id,
    candidates: scored.slice(0, Math.max(1, topK)),
    scoreByQuestionId,
    signalsByQuestionId,
  };
}

/**
 * Ranks candidates. Falls through to the question id so the order is total
 * and identical inputs always produce an identical shortlist.
 */
function compareCandidates(a: MappingCandidate, b: MappingCandidate): number {
  if (b.candidateScore !== a.candidateScore) return b.candidateScore - a.candidateScore;
  if (b.signals.label !== a.signals.label) return b.signals.label - a.signals.label;
  if (b.signals.semantic !== a.signals.semantic) return b.signals.semantic - a.signals.semantic;
  return a.questionId.localeCompare(b.questionId);
}

/**
 * Text handed to the embedding model for a question.
 *
 * A sub-question is embedded with its parent's wording, because "(a) Describe
 * its role" carries almost no meaning alone — the parent is what makes it
 * comparable to a student's answer. Ids, coordinates and metadata are
 * excluded: they are not meaning, and they would dilute the vector.
 */
export function questionEmbeddingText(
  question: Question,
  allQuestions: readonly Question[],
): string {
  const parts = [question.text];

  if (question.isSubQuestion && question.parentLabel) {
    const parent = allQuestions.find(
      (candidate) =>
        !candidate.isSubQuestion &&
        String(candidate.sortKey.major) === question.parentLabel,
    );

    if (parent) parts.unshift(parent.text);
  }

  return parts.join('\n').trim();
}

/** Text handed to the embedding model for an answer: the transcription only. */
export function answerEmbeddingText(answer: Answer): string {
  return answer.text.trim();
}
