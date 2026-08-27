import { describe, expect, it } from 'vitest';
import {
  bandForConfidence,
  calculateCandidateScore,
  calculateFinalConfidence,
  deriveReasonCodes,
  statusForBand,
  LABEL_MATCH_SCORES,
  NEUTRAL_SIGNAL,
  type MappingSignals,
} from '@/lib/domain/mapping';

function signals(overrides: Partial<MappingSignals> = {}): MappingSignals {
  return {
    label: NEUTRAL_SIGNAL,
    labelKind: 'NO_LABEL',
    semantic: NEUTRAL_SIGNAL,
    semanticCosine: 0.8,
    position: NEUTRAL_SIGNAL,
    structure: NEUTRAL_SIGNAL,
    ...overrides,
  };
}

describe('candidate score', () => {
  it('is 1 when every signal is at maximum', () => {
    expect(
      calculateCandidateScore(
        signals({ label: 1, semantic: 1, position: 1, structure: 1 }),
      ),
    ).toBeCloseTo(1, 6);
  });

  it('is 0 when every signal is at minimum', () => {
    expect(
      calculateCandidateScore(
        signals({ label: 0, semantic: 0, position: 0, structure: 0 }),
      ),
    ).toBeCloseTo(0, 6);
  });

  it('weights label most heavily of the four', () => {
    const labelOnly = calculateCandidateScore(
      signals({ label: 1, semantic: 0, position: 0, structure: 0 }),
    );
    const semanticOnly = calculateCandidateScore(
      signals({ label: 0, semantic: 1, position: 0, structure: 0 }),
    );
    const positionOnly = calculateCandidateScore(
      signals({ label: 0, semantic: 0, position: 1, structure: 0 }),
    );

    expect(labelOnly).toBeGreaterThan(semanticOnly);
    expect(semanticOnly).toBeGreaterThan(positionOnly);
  });

  it('stays inside the unit interval', () => {
    const score = calculateCandidateScore(
      signals({ label: 1, semantic: 1, position: 1, structure: 1 }),
    );
    expect(score).toBeLessThanOrEqual(1);
    expect(score).toBeGreaterThanOrEqual(0);
  });
});

describe('final confidence', () => {
  const strong = signals({
    label: LABEL_MATCH_SCORES.EXACT_NORMALIZED_LABEL,
    labelKind: 'EXACT_NORMALIZED_LABEL',
    semantic: 0.9,
    position: 0.75,
    structure: 0.7,
  });

  it('never simply copies the model confidence', () => {
    // A model claiming certainty on a weak candidate must not walk away with
    // a high score.
    const weak = signals({ label: 0, labelKind: 'CONFLICTING_LABEL', semantic: 0.1 });

    const confidence = calculateFinalConfidence({
      signals: weak,
      candidateScore: calculateCandidateScore(weak),
      llmSelected: true,
      llmConfidence: 1,
      llmConsulted: true,
    });

    expect(confidence).toBeLessThan(0.6);
  });

  it('raises confidence when the adjudicator agrees', () => {
    const base = {
      signals: strong,
      candidateScore: calculateCandidateScore(strong),
      llmConsulted: true,
    };

    const agreed = calculateFinalConfidence({
      ...base,
      llmSelected: true,
      llmConfidence: 0.95,
    });
    const disagreed = calculateFinalConfidence({
      ...base,
      llmSelected: false,
      llmConfidence: 0.95,
    });

    expect(agreed).toBeGreaterThan(disagreed);
  });

  it('lets the deterministic score stand when the model was not consulted', () => {
    const candidateScore = calculateCandidateScore(strong);

    const confidence = calculateFinalConfidence({
      signals: strong,
      candidateScore,
      llmSelected: false,
      llmConfidence: null,
      llmConsulted: false,
    });

    // A provider outage must not penalise a mapping that had nothing to do
    // with it.
    expect(confidence).toBeCloseTo(candidateScore, 6);
  });

  it('penalises a contradicted label', () => {
    const conflicting = signals({
      label: 0,
      labelKind: 'CONFLICTING_LABEL',
      semantic: 0.9,
      position: 0.7,
      structure: 0.7,
    });
    const neutral = { ...conflicting, label: 0, labelKind: 'NO_LABEL' as const };

    const withConflict = calculateFinalConfidence({
      signals: conflicting,
      candidateScore: calculateCandidateScore(conflicting),
      llmSelected: true,
      llmConfidence: 0.9,
      llmConsulted: true,
    });
    const withoutConflict = calculateFinalConfidence({
      signals: neutral,
      candidateScore: calculateCandidateScore(neutral),
      llmSelected: true,
      llmConfidence: 0.9,
      llmConsulted: true,
    });

    expect(withConflict).toBeLessThan(withoutConflict);
  });

  it('stays inside the unit interval at both extremes', () => {
    const best = calculateFinalConfidence({
      signals: signals({ label: 1, semantic: 1, position: 1, structure: 1 }),
      candidateScore: 1,
      llmSelected: true,
      llmConfidence: 1,
      llmConsulted: true,
    });
    const worst = calculateFinalConfidence({
      signals: signals({ label: 0, labelKind: 'CONFLICTING_LABEL' }),
      candidateScore: 0,
      llmSelected: false,
      llmConfidence: 0,
      llmConsulted: true,
    });

    expect(best).toBeLessThanOrEqual(1);
    expect(worst).toBeGreaterThanOrEqual(0);
  });
});

describe('confidence bands', () => {
  it('places 0.90 and above in HIGH, which auto-maps', () => {
    expect(bandForConfidence(0.9)).toBe('HIGH');
    expect(bandForConfidence(0.97)).toBe('HIGH');
    expect(statusForBand('HIGH')).toBe('AUTO_MAPPED');
  });

  it('places 0.70 to 0.89 in MEDIUM, which asks for review', () => {
    expect(bandForConfidence(0.7)).toBe('MEDIUM');
    expect(bandForConfidence(0.89)).toBe('MEDIUM');
    expect(statusForBand('MEDIUM')).toBe('REVIEW_REQUIRED');
  });

  it('places below 0.70 in LOW, which goes to a human', () => {
    expect(bandForConfidence(0.69)).toBe('LOW');
    expect(bandForConfidence(0)).toBe('LOW');
    expect(statusForBand('LOW')).toBe('HUMAN_REVIEW');
  });

  it('never silently accepts a low-confidence mapping', () => {
    expect(statusForBand(bandForConfidence(0.4))).toBe('HUMAN_REVIEW');
  });
});

describe('reason codes', () => {
  const base = {
    llmSelected: true,
    llmConsulted: true,
    llmDecidedNoMatch: false,
    band: 'HIGH' as const,
    conflictResolved: false,
  };

  it('leads with a direct label match', () => {
    const codes = deriveReasonCodes({
      ...base,
      signals: signals({ label: 1, labelKind: 'EXACT_NORMALIZED_LABEL', semantic: 0.9 }),
    });

    expect(codes[0]).toBe('DIRECT_LABEL_MATCH');
    expect(codes).toContain('LABEL_AND_SEMANTIC_AGREE');
    expect(codes).toContain('LLM_VERIFIED');
  });

  it('reports a semantic match when there was no usable label', () => {
    const codes = deriveReasonCodes({
      ...base,
      signals: signals({ label: NEUTRAL_SIGNAL, labelKind: 'NO_LABEL', semantic: 0.85 }),
    });

    expect(codes).toContain('SEMANTIC_MATCH');
    expect(codes).not.toContain('DIRECT_LABEL_MATCH');
  });

  it('reports a sub-part-only match', () => {
    const codes = deriveReasonCodes({
      ...base,
      signals: signals({ label: 0.45, labelKind: 'SUBPART_ONLY' }),
    });

    expect(codes).toContain('SUBPART_ONLY_MATCH');
  });

  it('records a label conflict', () => {
    const codes = deriveReasonCodes({
      ...base,
      signals: signals({ label: 0, labelKind: 'CONFLICTING_LABEL' }),
    });

    expect(codes).toContain('LABEL_CONFLICT');
  });

  it('distinguishes agreement, disagreement and absence of the adjudicator', () => {
    const agreed = deriveReasonCodes({ ...base, signals: signals() });
    const alternative = deriveReasonCodes({ ...base, signals: signals(), llmSelected: false });
    const noMatch = deriveReasonCodes({
      ...base,
      signals: signals(),
      llmSelected: false,
      llmDecidedNoMatch: true,
    });
    const absent = deriveReasonCodes({
      ...base,
      signals: signals(),
      llmSelected: false,
      llmConsulted: false,
    });

    expect(agreed).toContain('LLM_VERIFIED');
    expect(alternative).toContain('LLM_SELECTED_ALTERNATIVE');
    expect(noMatch).toContain('LLM_NO_MATCH');
    expect(absent).toContain('LLM_UNAVAILABLE');
  });

  it('records positional and structural support when present', () => {
    const codes = deriveReasonCodes({
      ...base,
      signals: signals({ position: 0.85, structure: 0.8 }),
    });

    expect(codes).toContain('POSITIONAL_SUPPORT');
    expect(codes).toContain('STRUCTURAL_SUPPORT');
  });

  it('flags a resolved conflict and a low band', () => {
    const codes = deriveReasonCodes({
      ...base,
      signals: signals(),
      band: 'LOW',
      conflictResolved: true,
    });

    expect(codes).toContain('CONFLICT_RESOLVED');
    expect(codes).toContain('LOW_CONFIDENCE');
  });

  it('never returns an empty explanation', () => {
    expect(deriveReasonCodes({ ...base, signals: signals() }).length).toBeGreaterThan(0);
  });
});
