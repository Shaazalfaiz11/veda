import { describe, expect, it } from 'vitest';

const {
  calculateAwardedMarks,
  calculateGradingConfidence,
  generateMarkSchemeFromQuestion,
  markSchemeVersion,
  outcomeForMarks,
  resolveGradingStatus,
  validateCriterionMarks,
  validateTotalMarks,
  verifyCriterionTotal,
} = await import('@/lib/domain/grading');

const { ValidationError } = await import('@/lib/errors');

import type { CriterionGrade, MarkScheme, RubricCriterion } from '@/lib/domain/grading';

function criterion(
  id: string,
  maxMarks: number,
  allowsPartialCredit = true,
): RubricCriterion {
  return {
    id,
    description: `Criterion ${id}`,
    maxMarks,
    acceptableConcepts: [],
    allowsPartialCredit,
  };
}

function graded(id: string, awarded: number, max: number): CriterionGrade {
  return {
    criterionId: id,
    description: `Criterion ${id}`,
    awardedMarks: awarded,
    maximumMarks: max,
    outcome: outcomeForMarks(awarded, max),
    reason: 'because',
  };
}

const GENERATED = generateMarkSchemeFromQuestion({
  questionId: 'q-1',
  questionText: 'Explain osmosis.',
  marks: 4,
});

function provided(criteria: RubricCriterion[]): MarkScheme {
  const totalMarks = criteria.reduce((total, c) => total + c.maxMarks, 0);

  return {
    questionId: 'q-1',
    source: 'PROVIDED',
    totalMarks,
    criteria,
    modelAnswer: null,
    granularity: 'WHOLE',
    version: markSchemeVersion('q-1', totalMarks, criteria),
  };
}

describe('the total is the application’s, not the model’s', () => {
  it('adds the criterion marks up itself', () => {
    expect(calculateAwardedMarks([graded('c1', 2, 3), graded('c2', 1, 2)])).toBe(3);
  });

  it('rejects a model total that disagrees with its own criteria', () => {
    expect(() => verifyCriterionTotal([graded('c1', 2, 3), graded('c2', 1, 2)], 4)).toThrow(
      ValidationError,
    );
  });

  it('does not quietly adopt whichever number it prefers', () => {
    // The point of rejecting: neither 3 nor 4 is trustworthy once they
    // disagree, so no repaired value is produced at all.
    let thrown: unknown;
    try {
      verifyCriterionTotal([graded('c1', 2, 3)], 3);
    } catch (error) {
      thrown = error;
    }

    expect(thrown).toBeInstanceOf(ValidationError);
    expect((thrown as Error).message).toContain('internally inconsistent');
  });

  it('tolerates floating-point noise but not genuine disagreement', () => {
    expect(() => verifyCriterionTotal([graded('c1', 0.1, 1), graded('c2', 0.2, 1)], 0.3)).not.toThrow();
    expect(() => verifyCriterionTotal([graded('c1', 0.1, 1), graded('c2', 0.2, 1)], 0.4)).toThrow();
  });
});

describe('criterion validation', () => {
  it('rejects marks above what the criterion is worth', () => {
    expect(() => validateCriterionMarks(4, criterion('c1', 3), GENERATED)).toThrow(
      ValidationError,
    );
  });

  it('rejects a fractional mark under a whole-mark policy', () => {
    expect(() => validateCriterionMarks(1.5, criterion('c1', 3), GENERATED)).toThrow(
      ValidationError,
    );
  });

  it('accepts a half mark when the scheme allows halves', () => {
    const halves: MarkScheme = { ...GENERATED, granularity: 'HALF' };

    expect(() => validateCriterionMarks(1.5, criterion('c1', 3), halves)).not.toThrow();
  });

  it('rejects a partial award on an all-or-nothing criterion', () => {
    const strict = criterion('c1', 2, false);

    expect(() => validateCriterionMarks(1, strict, GENERATED)).toThrow(ValidationError);
    expect(() => validateCriterionMarks(0, strict, GENERATED)).not.toThrow();
    expect(() => validateCriterionMarks(2, strict, GENERATED)).not.toThrow();
  });

  it('rejects a negative mark', () => {
    expect(() => validateCriterionMarks(-1, criterion('c1', 3), GENERATED)).toThrow(
      ValidationError,
    );
  });
});

describe('total validation', () => {
  it('rejects a total above what the question is worth', () => {
    expect(() => validateTotalMarks(5, GENERATED)).toThrow(ValidationError);
  });

  it('rejects a negative total', () => {
    expect(() => validateTotalMarks(-1, GENERATED)).toThrow(ValidationError);
  });

  it('accepts a total at the ceiling', () => {
    expect(() => validateTotalMarks(4, GENERATED)).not.toThrow();
  });
});

describe('criterion outcomes are derived, not claimed', () => {
  it('reads the outcome off the marks', () => {
    expect(outcomeForMarks(3, 3)).toBe('SATISFIED');
    expect(outcomeForMarks(1, 3)).toBe('PARTIAL');
    expect(outcomeForMarks(0, 3)).toBe('NOT_SATISFIED');
  });
});

describe('grading confidence', () => {
  const base = {
    answerHasUncertainSegments: false,
    answerContainsDiagram: false,
    questionExpectsDiagram: false,
    modelConfidence: 0.9,
    criteria: [graded('c1', 4, 4)],
  };

  it('trusts a grade made against a real mark scheme more than a derived one', () => {
    const withProvided = calculateGradingConfidence({
      ...base,
      scheme: provided([criterion('c1', 4)]),
    });
    const withGenerated = calculateGradingConfidence({ ...base, scheme: GENERATED });

    expect(withProvided.confidence).toBeGreaterThan(withGenerated.confidence);
    expect(withProvided.factors.rubricQuality).toBe(1);
  });

  it('drops when the transcription admitted it could not read the answer', () => {
    const clear = calculateGradingConfidence({ ...base, scheme: GENERATED });
    const unclear = calculateGradingConfidence({
      ...base,
      scheme: GENERATED,
      answerHasUncertainSegments: true,
    });

    expect(unclear.confidence).toBeLessThan(clear.confidence);
    expect(unclear.factors.transcriptionClarity).toBeLessThan(1);
  });

  it('drops when a diagram the question asked for cannot be seen', () => {
    const seen = calculateGradingConfidence({ ...base, scheme: GENERATED });
    const drawn = calculateGradingConfidence({
      ...base,
      scheme: GENERATED,
      answerContainsDiagram: true,
      questionExpectsDiagram: true,
    });

    expect(drawn.confidence).toBeLessThan(seen.confidence);
  });

  it('is not simply the model’s own confidence', () => {
    const result = calculateGradingConfidence({
      ...base,
      scheme: GENERATED,
      modelConfidence: 1,
    });

    // A model certain of itself against a rubric we invented still does not
    // get to award itself certainty.
    expect(result.confidence).toBeLessThan(1);
    expect(result.factors.modelConfidence).toBe(1);
  });

  it('treats a row of borderline partials as less clear-cut than decided ones', () => {
    const decided = calculateGradingConfidence({
      ...base,
      scheme: GENERATED,
      criteria: [graded('c1', 2, 2), graded('c2', 0, 2)],
    });
    const borderline = calculateGradingConfidence({
      ...base,
      scheme: GENERATED,
      criteria: [graded('c1', 1, 2), graded('c2', 1, 2)],
    });

    expect(borderline.confidence).toBeLessThan(decided.confidence);
  });
});

describe('whether a grade can stand unattended', () => {
  const clean = {
    confidence: 0.95,
    scheme: provided([criterion('c1', 4)]),
    answerHasUncertainSegments: false,
    answerContainsDiagram: false,
    questionExpectsDiagram: false,
  };

  it('stands when the rubric is real and nothing is in doubt', () => {
    const { status, reviewReasons } = resolveGradingStatus(clean);

    expect(status).toBe('GRADED');
    expect(reviewReasons).toEqual([]);
  });

  it('asks for a human when confidence is below the threshold', () => {
    const { status, reviewReasons } = resolveGradingStatus({ ...clean, confidence: 0.4 });

    expect(status).toBe('REVIEW_REQUIRED');
    expect(reviewReasons).toContain('LOW_GRADING_CONFIDENCE');
  });

  it('asks for a human whenever the rubric was derived rather than supplied', () => {
    const { status, reviewReasons } = resolveGradingStatus({ ...clean, scheme: GENERATED });

    expect(status).toBe('REVIEW_REQUIRED');
    expect(reviewReasons).toContain('GENERATED_RUBRIC');
  });

  it('flags an illegible answer even when the marks came out confidently', () => {
    const { reviewReasons } = resolveGradingStatus({
      ...clean,
      answerHasUncertainSegments: true,
    });

    expect(reviewReasons).toContain('UNCERTAIN_TRANSCRIPTION');
  });

  it('flags a drawing only when the question actually asked for one', () => {
    const incidental = resolveGradingStatus({ ...clean, answerContainsDiagram: true });
    const required = resolveGradingStatus({
      ...clean,
      answerContainsDiagram: true,
      questionExpectsDiagram: true,
    });

    expect(incidental.reviewReasons).not.toContain('DIAGRAM_NOT_ASSESSABLE');
    expect(required.reviewReasons).toContain('DIAGRAM_NOT_ASSESSABLE');
  });

  it('never withholds the marks — review is about who looks, not what is computed', () => {
    const { status } = resolveGradingStatus({ ...clean, confidence: 0 });

    expect(status).toBe('REVIEW_REQUIRED');
    expect(status).not.toBe('NOT_GRADEABLE');
  });
});
