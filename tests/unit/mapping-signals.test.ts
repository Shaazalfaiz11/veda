import { describe, expect, it } from 'vitest';
import {
  classifyLabelMatch,
  cosineSimilarity,
  absoluteSemanticScore,
  relativeSemanticScore,
  semanticScore,
  positionScore,
  scoreLabelMatch,
  structureScore,
  diagramCompatibility,
  lengthCompatibility,
  subQuestionCompatibility,
  expectsDiagram,
} from '@/lib/services/mapping/signals';
import { LABEL_MATCH_SCORES, NEUTRAL_SIGNAL } from '@/lib/domain/mapping';
import { parseQuestionLabel } from '@/lib/domain/question';
import type { Question } from '@/lib/domain/question';
import type { Answer } from '@/lib/domain/answer';

function question(labelRaw: string, overrides: Partial<Question> = {}): Question {
  const parsed = parseQuestionLabel(labelRaw);

  return {
    id: `q-${labelRaw}`,
    labelRaw,
    normalizedLabel: parsed.normalizedLabel,
    sortKey: parsed.sortKey,
    parentLabel: parsed.parentLabel,
    isSubQuestion: parsed.isSubQuestion,
    text: 'Which organelle is primarily involved in photosynthesis?',
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.05 }],
    pageNumbers: [1],
    ...overrides,
  };
}

function answer(claimedLabelRaw: string | null, overrides: Partial<Answer> = {}): Answer {
  const normalized = claimedLabelRaw
    ? parseQuestionLabel(claimedLabelRaw).normalizedLabel
    : null;

  return {
    id: `a-${claimedLabelRaw ?? 'none'}`,
    claimedLabelRaw,
    claimedLabelNormalized: normalized,
    text: 'The chloroplast is responsible.',
    regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.6, height: 0.05, kind: 'text' }],
    pageNumbers: [1],
    spansPages: false,
    hasUncertainSegments: false,
    containsDiagram: false,
    documentPosition: 0,
    ...overrides,
  };
}

describe('label matching', () => {
  it('treats every spelling of the same number as an exact match', () => {
    for (const written of ['Q4', '4', '4.', 'Question 4', 'Ans 4']) {
      expect(classifyLabelMatch(answer(written), question('4.'))).toBe(
        'EXACT_NORMALIZED_LABEL',
      );
    }
  });

  it('matches a written sub-question against the same sub-question', () => {
    expect(classifyLabelMatch(answer('6(a)'), question('6(a)'))).toBe(
      'EXACT_PARENT_AND_SUBQUESTION',
    );
  });

  it('matches the same sub-part reached by different spellings', () => {
    expect(classifyLabelMatch(answer('Q6a'), question('6 (a)'))).toBe(
      'EXACT_PARENT_AND_SUBQUESTION',
    );
  });

  it('scores a bare "(a)" as sub-part only, never as a direct match', () => {
    // The student said their answer is *a* sub-part, not *which* question's.
    expect(classifyLabelMatch(answer('(a)'), question('6(a)'))).toBe('SUBPART_ONLY');
    expect(classifyLabelMatch(answer('(a)'), question('11(a)'))).toBe('SUBPART_ONLY');
  });

  it('gives every candidate sub-part the same score, so position must decide', () => {
    const orphan = answer('(a)');

    expect(scoreLabelMatch(orphan, question('6(a)')).score).toBe(
      scoreLabelMatch(orphan, question('11(a)')).score,
    );
  });

  it('does not match a bare "(a)" against a different sub-part', () => {
    expect(classifyLabelMatch(answer('(a)'), question('6(b)'))).toBe('CONFLICTING_LABEL');
  });

  it('does not match a bare "(a)" against a top-level question', () => {
    expect(classifyLabelMatch(answer('(a)'), question('6.'))).toBe('CONFLICTING_LABEL');
  });

  it('reports a parent-only match when one side names a sub-part', () => {
    expect(classifyLabelMatch(answer('6'), question('6(a)'))).toBe('PARENT_ONLY');
    expect(classifyLabelMatch(answer('6(a)'), question('6.'))).toBe('PARENT_ONLY');
  });

  it('reports a conflict when the sub-parts of one question disagree', () => {
    expect(classifyLabelMatch(answer('6(a)'), question('6(b)'))).toBe('CONFLICTING_LABEL');
  });

  it('reports a conflict when the numbers disagree', () => {
    expect(classifyLabelMatch(answer('Q4'), question('7.'))).toBe('CONFLICTING_LABEL');
  });

  it('is neutral when the student wrote no label', () => {
    const signal = scoreLabelMatch(answer(null), question('4.'));

    expect(signal.kind).toBe('NO_LABEL');
    expect(signal.score).toBe(NEUTRAL_SIGNAL);
  });

  it('scores a conflict at zero and an exact match at one', () => {
    expect(scoreLabelMatch(answer('Q4'), question('7.')).score).toBe(0);
    expect(scoreLabelMatch(answer('Q4'), question('4.')).score).toBe(1);
  });

  it('orders the scale so stronger evidence always scores higher', () => {
    expect(LABEL_MATCH_SCORES.EXACT_NORMALIZED_LABEL).toBeGreaterThan(
      LABEL_MATCH_SCORES.PARENT_ONLY,
    );
    expect(LABEL_MATCH_SCORES.PARENT_ONLY).toBeGreaterThan(LABEL_MATCH_SCORES.SUBPART_ONLY);
    expect(LABEL_MATCH_SCORES.SUBPART_ONLY).toBeLessThan(LABEL_MATCH_SCORES.NO_LABEL);
    expect(LABEL_MATCH_SCORES.NO_LABEL).toBeGreaterThan(LABEL_MATCH_SCORES.CONFLICTING_LABEL);
  });
});

describe('cosine similarity', () => {
  it('is 1 for identical vectors and 0 for orthogonal ones', () => {
    expect(cosineSimilarity([1, 0, 0], [1, 0, 0])).toBeCloseTo(1, 9);
    expect(cosineSimilarity([1, 0], [0, 1])).toBeCloseTo(0, 9);
  });

  it('ignores magnitude', () => {
    expect(cosineSimilarity([1, 2, 3], [2, 4, 6])).toBeCloseTo(1, 9);
  });

  it('returns 0 for a zero vector', () => {
    expect(cosineSimilarity([0, 0], [1, 1])).toBe(0);
  });

  it('rejects mismatched lengths rather than comparing nonsense', () => {
    expect(() => cosineSimilarity([1, 2], [1, 2, 3])).toThrow(/length mismatch/);
  });
});

describe('semantic rescaling', () => {
  it('maps the unrelated floor to zero', () => {
    // Two unrelated exam texts sit near the floor; that is no relationship,
    // not a 0.65 match.
    expect(absoluteSemanticScore(0.65)).toBeCloseTo(0, 6);
    expect(absoluteSemanticScore(0.6)).toBe(0);
  });

  it('maps a perfect cosine to one', () => {
    expect(absoluteSemanticScore(1)).toBeCloseTo(1, 6);
  });

  it('spreads the range above the floor', () => {
    expect(absoluteSemanticScore(0.9)).toBeGreaterThan(absoluteSemanticScore(0.8));
  });

  it('min-max scales against the candidate set, within a compressed band', () => {
    const all = [0.7, 0.8, 0.92];

    // Compressed into [0.2, 0.8]: with two or three candidates a raw min-max
    // would call the runner-up "completely unrelated" however close it was.
    expect(relativeSemanticScore(0.92, all)).toBeCloseTo(0.8, 6);
    expect(relativeSemanticScore(0.7, all)).toBeCloseTo(0.2, 6);
    expect(relativeSemanticScore(0.8, all)).toBeGreaterThan(0.2);
    expect(relativeSemanticScore(0.8, all)).toBeLessThan(0.8);
  });

  it('never lets the runner-up in a two-horse race score zero', () => {
    const pair = [0.9, 0.88];

    expect(relativeSemanticScore(0.88, pair)).toBeGreaterThanOrEqual(0.2);
  });

  it('is neutral when every candidate scores alike', () => {
    expect(relativeSemanticScore(0.8, [0.8, 0.8, 0.8])).toBe(NEUTRAL_SIGNAL);
    expect(relativeSemanticScore(0.8, [])).toBe(NEUTRAL_SIGNAL);
  });

  it('combines both so a lone weak match cannot look strong', () => {
    // Best of a uniformly poor field: relative standing says "top of the
    // pile", absolute says "related to nothing". Absolute leads, so the
    // result stays low.
    const weakField = semanticScore(0.66, [0.6, 0.62, 0.66]);
    const strongField = semanticScore(0.95, [0.6, 0.62, 0.95]);

    expect(weakField).toBeLessThan(0.35);
    expect(strongField).toBeGreaterThan(0.8);
    expect(strongField).toBeGreaterThan(weakField);
  });

  it('lets absolute similarity lead over relative standing', () => {
    // Same relative position at the top of its field; very different
    // absolute similarity. The absolute difference must dominate.
    const related = semanticScore(0.95, [0.7, 0.95]);
    const unrelated = semanticScore(0.67, [0.6, 0.67]);

    expect(related - unrelated).toBeGreaterThan(0.4);
  });
});

describe('positional support', () => {
  it('scores an aligned position above a misaligned one', () => {
    const aligned = positionScore({
      answerIndex: 0,
      answerCount: 5,
      questionIndex: 0,
      questionCount: 5,
    });
    const misaligned = positionScore({
      answerIndex: 0,
      answerCount: 5,
      questionIndex: 4,
      questionCount: 5,
    });

    expect(aligned).toBeGreaterThan(misaligned);
  });

  it('never reaches zero, so it can never veto a strong signal', () => {
    const worst = positionScore({
      answerIndex: 0,
      answerCount: 2,
      questionIndex: 1,
      questionCount: 2,
    });

    // Compressed into [0.25, 0.75] around neutral.
    expect(worst).toBeGreaterThan(0.2);
    expect(worst).toBeLessThan(NEUTRAL_SIGNAL);
  });

  it('stays inside the compressed band at both extremes', () => {
    const best = positionScore({
      answerIndex: 0,
      answerCount: 4,
      questionIndex: 0,
      questionCount: 4,
    });
    const worst = positionScore({
      answerIndex: 0,
      answerCount: 4,
      questionIndex: 3,
      questionCount: 4,
    });

    expect(best).toBeCloseTo(0.75, 6);
    expect(worst).toBeCloseTo(0.25, 6);
  });

  it('is neutral when there is only one item to order', () => {
    expect(
      positionScore({ answerIndex: 0, answerCount: 1, questionIndex: 0, questionCount: 3 }),
    ).toBe(NEUTRAL_SIGNAL);
  });

  it('stays within the unit interval', () => {
    for (let a = 0; a < 6; a += 1) {
      for (let q = 0; q < 6; q += 1) {
        const score = positionScore({
          answerIndex: a,
          answerCount: 6,
          questionIndex: q,
          questionCount: 6,
        });
        expect(score).toBeGreaterThanOrEqual(0);
        expect(score).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('structural compatibility', () => {
  it('recognises a question that asks for a drawing', () => {
    expect(expectsDiagram(question('5', { text: 'Draw a labelled diagram of a cell.' }))).toBe(
      true,
    );
    expect(expectsDiagram(question('5', { text: 'Define osmosis.' }))).toBe(false);
  });

  it('supports a drawn answer to a drawing question', () => {
    const drawing = question('5', { text: 'Draw a labelled diagram of an alveolus.' });

    expect(diagramCompatibility(answer('Q5', { containsDiagram: true }), drawing)).toBeGreaterThan(
      diagramCompatibility(answer('Q5', { containsDiagram: false }), drawing),
    );
  });

  it('does not penalise a diagram where none was asked for', () => {
    const prose = question('5', { text: 'Define osmosis.' });
    expect(diagramCompatibility(answer('Q5', { containsDiagram: true }), prose)).toBe(
      NEUTRAL_SIGNAL,
    );
  });

  it('prefers an answer roughly proportionate to the marks', () => {
    const fiveMarks = question('4', { marks: 5 });

    const proportionate = lengthCompatibility(
      answer('Q4', { text: 'x'.repeat(450) }),
      fiveMarks,
    );
    const tooShort = lengthCompatibility(answer('Q4', { text: 'Yes.' }), fiveMarks);

    expect(proportionate).toBeGreaterThan(tooShort);
  });

  it('is neutral when the paper prints no marks', () => {
    expect(lengthCompatibility(answer('Q4'), question('4', { marks: null }))).toBe(
      NEUTRAL_SIGNAL,
    );
  });

  it('never lets length drop the signal to zero', () => {
    expect(
      lengthCompatibility(answer('Q4', { text: 'x' }), question('4', { marks: 10 })),
    ).toBeGreaterThan(0.3);
  });

  it('prefers a sub-part answer against a sub-question', () => {
    expect(subQuestionCompatibility(answer('(a)'), question('6(a)'))).toBeGreaterThan(
      subQuestionCompatibility(answer('(a)'), question('6.')),
    );
  });

  it('is neutral about structure when no label was written', () => {
    expect(subQuestionCompatibility(answer(null), question('6(a)'))).toBe(NEUTRAL_SIGNAL);
  });

  it('stays within the unit interval', () => {
    const score = structureScore(
      answer('Q5', { containsDiagram: true, text: 'x'.repeat(400) }),
      question('5', { text: 'Draw a diagram.', marks: 5 }),
    );

    expect(score).toBeGreaterThanOrEqual(0);
    expect(score).toBeLessThanOrEqual(1);
  });
});
