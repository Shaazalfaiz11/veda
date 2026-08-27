import { getEnv } from '@/lib/config';
import type {
  ConfidenceBand,
  LabelMatchKind,
  MappingReasonCode,
  MappingSignals,
  MappingStatus,
} from './types';

/**
 * Confidence, in one place.
 *
 * Two numbers matter and they are deliberately distinct:
 *
 *   candidateScore   cheap, deterministic, computed for every pair. Used to
 *                    rank and to pick the top K that are worth an LLM call.
 *
 *   finalConfidence  what the application believes after adjudication. It is
 *                    calculated here, never copied from the model — a model
 *                    that is confidently wrong would otherwise hand itself a
 *                    high score and skip review entirely.
 *
 * Every weight and threshold comes from configuration. Nothing here is
 * claimed to be optimal; they are heuristics placed in one file precisely so
 * they can be measured and tuned rather than hunted for.
 */

/** Scores for each label comparison outcome, on a 0-1 scale. */
export const LABEL_MATCH_SCORES: Readonly<Record<LabelMatchKind, number>> = {
  /** Answer "Q4" against question "4." — the strongest evidence available. */
  EXACT_NORMALIZED_LABEL: 1,
  /** Answer "6(a)" against question "6 (a)". */
  EXACT_PARENT_AND_SUBQUESTION: 1,
  /** Same parent and same sub-part, reached by different spellings. */
  PARENT_MATCH_SUBPART_MATCH: 0.95,
  /** Answer "6" against question "6(a)" — right question, unclear part. */
  PARENT_ONLY: 0.6,
  /**
   * A bare "(a)" against some question's "(a)". Deliberately moderate: it
   * says the answer is *a* sub-part, not *which* question's sub-part, and
   * every "(a)" on the paper scores identically here. Position and semantics
   * have to break the tie.
   */
  SUBPART_ONLY: 0.45,
  /** The student wrote no label. No information either way. */
  NO_LABEL: 0.5,
  /** Both sides carry a label and they disagree. Actively contradicts. */
  CONFLICTING_LABEL: 0,
};

/** 0.5 is the neutral point: no evidence for or against. */
export const NEUTRAL_SIGNAL = 0.5;

export function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** A signal this close to neutral is treated as abstaining. */
const ABSTENTION_TOLERANCE = 1e-6;

/**
 * The cheap score used for ranking and top-K selection.
 *
 * A weighted average over the signals that actually carry information.
 * Signals sitting at neutral abstain and their weight is redistributed,
 * rather than being averaged in as if they were half-evidence.
 *
 * That distinction matters more than it looks. A perfect label match on a
 * one-answer sheet — where position has no ordering to compare against and
 * necessarily returns neutral — would otherwise be dragged from 1.0 to
 * around 0.55 by signals that said nothing at all, and could never reach the
 * HIGH band however strong the real evidence was.
 */
export function calculateCandidateScore(signals: MappingSignals): number {
  const env = getEnv();

  const contributions: Array<[number, number]> = [
    [env.MAPPING_WEIGHT_LABEL, signals.label],
    [env.MAPPING_WEIGHT_SEMANTIC, signals.semantic],
    [env.MAPPING_WEIGHT_POSITION, signals.position],
    [env.MAPPING_WEIGHT_STRUCTURE, signals.structure],
  ];

  let weighted = 0;
  let totalWeight = 0;

  for (const [weight, value] of contributions) {
    if (Math.abs(value - NEUTRAL_SIGNAL) < ABSTENTION_TOLERANCE) continue;

    weighted += weight * value;
    totalWeight += weight;
  }

  // Everything abstained: no evidence in either direction.
  if (totalWeight === 0) return NEUTRAL_SIGNAL;

  return clamp01(weighted / totalWeight);
}

export interface FinalConfidenceInput {
  signals: MappingSignals;
  candidateScore: number;

  /** True when the adjudicator picked this pair. */
  llmSelected: boolean;
  /** The model's own confidence, when it expressed one. */
  llmConfidence: number | null;
  /** True when adjudication ran at all for this answer. */
  llmConsulted: boolean;
}

/**
 * The confidence the application stands behind.
 *
 * The candidate score is blended with the adjudicator's agreement. When the
 * model was not consulted — or could not be reached — its weight collapses to
 * zero and the deterministic score carries the whole result, rather than the
 * mapping being penalised for a provider outage it had no part in.
 *
 * A contradicted label is subtracted at the end rather than folded into the
 * label signal, so the penalty is visible in isolation and cannot be diluted
 * by a strong score elsewhere.
 */
export function calculateFinalConfidence(input: FinalConfidenceInput): number {
  const env = getEnv();

  const llmWeight = input.llmConsulted ? env.MAPPING_WEIGHT_LLM : 0;

  // Agreement is the model's own confidence when it chose this pair, and 0
  // when it chose something else or declined to choose.
  const agreement = input.llmSelected ? clamp01(input.llmConfidence ?? 0) : 0;

  const blended = (1 - llmWeight) * input.candidateScore + llmWeight * agreement;

  const penalty =
    input.signals.labelKind === 'CONFLICTING_LABEL'
      ? env.MAPPING_LABEL_CONFLICT_PENALTY
      : 0;

  return clamp01(blended - penalty);
}

export function bandForConfidence(confidence: number): ConfidenceBand {
  const env = getEnv();

  if (confidence >= env.MAPPING_CONFIDENCE_HIGH) return 'HIGH';
  if (confidence >= env.MAPPING_CONFIDENCE_MEDIUM) return 'MEDIUM';
  return 'LOW';
}

/**
 * A band decides how a mapping is presented. Low confidence is never
 * silently accepted — it becomes work for a human rather than a quiet guess.
 */
export function statusForBand(band: ConfidenceBand): MappingStatus {
  switch (band) {
    case 'HIGH':
      return 'AUTO_MAPPED';
    case 'MEDIUM':
      return 'REVIEW_REQUIRED';
    case 'LOW':
      return 'HUMAN_REVIEW';
  }
}

/**
 * Derives the reasons a mapping ended where it did.
 *
 * Ordered strongest-evidence-first so the head of the list is the honest
 * one-line explanation a review screen can show.
 */
export function deriveReasonCodes(input: {
  signals: MappingSignals;
  llmSelected: boolean;
  llmConsulted: boolean;
  llmDecidedNoMatch: boolean;
  band: ConfidenceBand;
  conflictResolved: boolean;
  /** True when adjudication was skipped as unnecessary rather than failing. */
  adjudicationSkipped?: boolean;
}): MappingReasonCode[] {
  const codes: MappingReasonCode[] = [];
  const { signals } = input;

  switch (signals.labelKind) {
    case 'EXACT_NORMALIZED_LABEL':
      codes.push('DIRECT_LABEL_MATCH');
      break;
    case 'EXACT_PARENT_AND_SUBQUESTION':
    case 'PARENT_MATCH_SUBPART_MATCH':
      codes.push('PARENT_SUBPART_MATCH');
      break;
    case 'SUBPART_ONLY':
      codes.push('SUBPART_ONLY_MATCH');
      break;
    case 'CONFLICTING_LABEL':
      codes.push('LABEL_CONFLICT');
      break;
    default:
      break;
  }

  const strongSemantic = signals.semantic >= 0.7;
  const strongLabel = signals.label >= 0.9;

  if (strongSemantic && strongLabel) codes.push('LABEL_AND_SEMANTIC_AGREE');
  else if (strongSemantic) codes.push('SEMANTIC_MATCH');

  if (signals.position >= 0.8) codes.push('POSITIONAL_SUPPORT');
  if (signals.structure >= 0.7) codes.push('STRUCTURAL_SUPPORT');

  if (input.adjudicationSkipped) codes.push('ADJUDICATION_UNNECESSARY');
  else if (!input.llmConsulted) codes.push('LLM_UNAVAILABLE');
  else if (input.llmDecidedNoMatch) codes.push('LLM_NO_MATCH');
  else if (input.llmSelected) codes.push('LLM_VERIFIED');
  else codes.push('LLM_SELECTED_ALTERNATIVE');

  if (input.conflictResolved) codes.push('CONFLICT_RESOLVED');
  if (input.band === 'LOW') codes.push('LOW_CONFIDENCE');

  return codes;
}
