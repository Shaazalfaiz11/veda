import { describe, expect, it } from 'vitest';

const {
  generateMarkSchemeFromQuestion,
  isValidMarkValue,
  markSchemeVersion,
  sumCriterionMaxMarks,
} = await import('@/lib/domain/grading');

const { assertUsableMarkScheme, findMarkScheme, resolveMarkSchemes } = await import(
  '@/lib/services/grading'
);
const { parseQuestionLabel } = await import('@/lib/domain/question');
const { ValidationError } = await import('@/lib/errors');

import type { Question } from '@/lib/domain/question';
import type { RubricCriterion } from '@/lib/domain/grading';

function question(id: string, labelRaw: string, marks: number | null): Question {
  const parsed = parseQuestionLabel(labelRaw);

  return {
    id,
    labelRaw,
    normalizedLabel: parsed.normalizedLabel,
    sortKey: parsed.sortKey,
    parentLabel: parsed.parentLabel,
    isSubQuestion: parsed.isSubQuestion,
    text: `Body of ${labelRaw}`,
    marks,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
  };
}

function criterion(id: string, maxMarks: number): RubricCriterion {
  return {
    id,
    description: `Criterion ${id}`,
    maxMarks,
    acceptableConcepts: [],
    allowsPartialCredit: true,
  };
}

describe('mark scheme versioning', () => {
  it('is stable across criterion order and incidental whitespace', () => {
    const a = markSchemeVersion('q-1', 4, [criterion('c1', 2), criterion('c2', 2)]);
    const b = markSchemeVersion('q-1', 4, [
      { ...criterion('c2', 2), description: '  Criterion c2  ' },
      criterion('c1', 2),
    ]);

    expect(a).toBe(b);
  });

  it('changes when the marks change, so an old grade is not attributed to a new rubric', () => {
    const before = markSchemeVersion('q-1', 4, [criterion('c1', 4)]);
    const after = markSchemeVersion('q-1', 5, [criterion('c1', 5)]);

    expect(before).not.toBe(after);
  });
});

describe('mark granularity', () => {
  it('rejects a half mark when the policy is whole marks', () => {
    expect(isValidMarkValue(1, 'WHOLE')).toBe(true);
    expect(isValidMarkValue(0.5, 'WHOLE')).toBe(false);
  });

  it('accepts halves but nothing finer when the policy allows them', () => {
    expect(isValidMarkValue(0.5, 'HALF')).toBe(true);
    expect(isValidMarkValue(1.5, 'HALF')).toBe(true);
    expect(isValidMarkValue(0.25, 'HALF')).toBe(false);
  });

  it('rejects negative and non-finite marks under either policy', () => {
    expect(isValidMarkValue(-1, 'WHOLE')).toBe(false);
    expect(isValidMarkValue(Number.NaN, 'HALF')).toBe(false);
  });
});

describe('generating a rubric from a question', () => {
  it('is labelled GENERATED and carries the question own mark ceiling', () => {
    const scheme = generateMarkSchemeFromQuestion({
      questionId: 'q-1',
      questionText: 'Explain osmosis.',
      marks: 3,
    });

    expect(scheme.source).toBe('GENERATED');
    expect(scheme.totalMarks).toBe(3);
    expect(sumCriterionMaxMarks(scheme.criteria)).toBe(3);
  });

  it('invents no criteria the paper did not state', () => {
    const scheme = generateMarkSchemeFromQuestion({
      questionId: 'q-1',
      questionText: 'Explain osmosis.',
      marks: 3,
    });

    expect(scheme.criteria).toHaveLength(1);
    expect(scheme.criteria[0]!.description).toContain('Explain osmosis.');
  });
});

describe('resolving mark schemes', () => {
  it('derives a scheme for every question that prints its marks', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 2), question('q-2', 'Q2', 5)],
    });

    expect(set.schemes.map((s) => s.totalMarks)).toEqual([2, 5]);
    expect(set.schemes.every((s) => s.source === 'GENERATED')).toBe(true);
  });

  it('produces nothing for a question with no marks rather than inventing a total', () => {
    const set = resolveMarkSchemes({ questions: [question('q-1', 'Q1', null)] });

    expect(set.schemes).toEqual([]);
    expect(findMarkScheme(set, 'q-1')).toBeNull();
  });

  it('ties a supplied rubric to its question through label normalisation', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-4', 'Q4', 4)],
      provided: [
        { labelRaw: '4.', totalMarks: 4, criteria: [criterion('c1', 2), criterion('c2', 2)] },
      ],
    });

    const scheme = findMarkScheme(set, 'q-4');

    expect(scheme?.source).toBe('PROVIDED');
    expect(scheme?.criteria).toHaveLength(2);
    expect(set.unresolved).toEqual([]);
  });

  it('a supplied rubric replaces the derived one for that question', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 4), question('q-2', 'Q2', 3)],
      provided: [{ labelRaw: 'Q1', totalMarks: 4, criteria: [criterion('c1', 4)] }],
    });

    expect(findMarkScheme(set, 'q-1')?.source).toBe('PROVIDED');
    expect(findMarkScheme(set, 'q-2')?.source).toBe('GENERATED');
    expect(set.schemes).toHaveLength(2);
  });

  it('leaves a rubric that matches no question unresolved rather than guessing', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 2)],
      provided: [{ labelRaw: 'Q9', totalMarks: 2, criteria: [criterion('c1', 2)] }],
    });

    expect(set.schemes.every((s) => s.source === 'GENERATED')).toBe(true);
    expect(set.unresolved).toHaveLength(1);
    expect(set.unresolved[0]!.reason).toContain('No extracted question matches');
  });

  it('refuses an ambiguous match rather than picking one of the candidates', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 2), question('q-1b', 'Q1', 2)],
      provided: [{ labelRaw: 'Q1', totalMarks: 2, criteria: [criterion('c1', 2)] }],
    });

    expect(set.unresolved[0]!.reason).toContain('ambiguous');
    expect(set.schemes.every((s) => s.source === 'GENERATED')).toBe(true);
  });

  it('keeps the first rubric for a question and marks a second as unresolved', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 2)],
      provided: [
        { labelRaw: 'Q1', totalMarks: 2, criteria: [criterion('first', 2)] },
        { labelRaw: 'Q1', totalMarks: 2, criteria: [criterion('second', 2)] },
      ],
    });

    expect(findMarkScheme(set, 'q-1')?.criteria[0]!.id).toBe('first');
    expect(set.unresolved).toHaveLength(1);
    expect(set.unresolved[0]!.reason).toContain('already has a mark scheme');
  });

  it('rejects a rubric whose criteria do not add up to what the question is worth', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 5)],
      provided: [
        { labelRaw: 'Q1', totalMarks: 5, criteria: [criterion('c1', 3), criterion('c2', 3)] },
      ],
    });

    expect(set.unresolved[0]!.reason).toContain('inconsistent');
    // Falls back to the derived rubric rather than marking against a broken one.
    expect(findMarkScheme(set, 'q-1')?.source).toBe('GENERATED');
  });

  it('rejects a rubric with a criterion worth nothing', () => {
    const set = resolveMarkSchemes({
      questions: [question('q-1', 'Q1', 2)],
      provided: [{ labelRaw: 'Q1', totalMarks: 2, criteria: [criterion('c1', 0)] }],
    });

    expect(set.unresolved[0]!.reason).toContain('invalid mark allocation');
  });
});

describe('guarding a rubric before it marks anything', () => {
  const base = generateMarkSchemeFromQuestion({
    questionId: 'q-1',
    questionText: 'Explain osmosis.',
    marks: 4,
  });

  it('accepts a consistent scheme', () => {
    expect(() => assertUsableMarkScheme(base)).not.toThrow();
  });

  it('throws when the criteria do not sum to the total', () => {
    expect(() => assertUsableMarkScheme({ ...base, criteria: [criterion('c1', 1)] })).toThrow(
      ValidationError,
    );
  });

  it('throws on duplicate criterion ids', () => {
    expect(() =>
      assertUsableMarkScheme({
        ...base,
        totalMarks: 4,
        criteria: [criterion('c1', 2), criterion('c1', 2)],
      }),
    ).toThrow(ValidationError);
  });

  it('throws when there are no criteria at all', () => {
    expect(() => assertUsableMarkScheme({ ...base, criteria: [] })).toThrow(ValidationError);
  });
});
