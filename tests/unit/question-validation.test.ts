import { describe, expect, it } from 'vitest';
import { validateQuestionCandidates } from '@/lib/services/question/question-validation';
import type { ExtractedQuestionCandidate } from '@/lib/providers/ai';

const PAGES = [1, 2, 3];

function candidate(overrides: Partial<ExtractedQuestionCandidate> = {}): ExtractedQuestionCandidate {
  return {
    labelRaw: 'Q1',
    text: 'Name the organelle responsible for photosynthesis.',
    marks: 2,
    pageNumber: 1,
    rects: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.05 }],
    ...overrides,
  };
}

function validate(candidates: ExtractedQuestionCandidate[]) {
  return validateQuestionCandidates({ candidates, availablePageNumbers: PAGES });
}

describe('accepting well-formed candidates', () => {
  it('produces a domain question with a server-generated id', () => {
    const { questions } = validate([candidate()]);

    expect(questions).toHaveLength(1);
    expect(questions[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(questions[0]!.labelRaw).toBe('Q1');
    expect(questions[0]!.normalizedLabel).toBe('1');
    expect(questions[0]!.marks).toBe(2);
  });

  it('never lets the model supply the identity', () => {
    // Any id-shaped field on the candidate is simply not read.
    const withId = { ...candidate(), id: 'model-chosen-id' } as ExtractedQuestionCandidate;
    const { questions } = validate([withId]);

    expect(questions[0]!.id).not.toBe('model-chosen-id');
  });

  it('generates a distinct id per question', () => {
    const { questions } = validate([
      candidate({ labelRaw: 'Q1' }),
      candidate({ labelRaw: 'Q2' }),
    ]);

    expect(new Set(questions.map((q) => q.id)).size).toBe(2);
  });

  it('keeps marks null when the paper printed none', () => {
    const { questions } = validate([candidate({ marks: null })]);
    expect(questions[0]!.marks).toBeNull();
  });

  it('accepts zero marks as a real allocation', () => {
    const { questions } = validate([candidate({ marks: 0 })]);
    expect(questions[0]!.marks).toBe(0);
  });

  it('trims surrounding whitespace from label and text', () => {
    const { questions } = validate([candidate({ labelRaw: '  Q3  ', text: '  Explain.  ' })]);

    expect(questions[0]!.labelRaw).toBe('Q3');
    expect(questions[0]!.text).toBe('Explain.');
  });
});

describe('rejecting malformed candidates', () => {
  it('rejects a missing label', () => {
    const { questions, warnings, rejectedCount } = validate([candidate({ labelRaw: '' })]);

    expect(questions).toHaveLength(0);
    expect(rejectedCount).toBe(1);
    expect(warnings[0]?.code).toBe('REJECTED_CANDIDATE');
    expect(warnings[0]?.message).toMatch(/no label/);
  });

  it('rejects a whitespace-only label', () => {
    expect(validate([candidate({ labelRaw: '   ' })]).questions).toHaveLength(0);
  });

  it('rejects missing question text', () => {
    const { questions, warnings } = validate([candidate({ text: '' })]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/no text/);
  });

  it('rejects negative marks', () => {
    const { questions, warnings } = validate([candidate({ marks: -3 })]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/negative/);
  });

  it('rejects non-finite marks', () => {
    expect(validate([candidate({ marks: Number.NaN })]).questions).toHaveLength(0);
  });

  it('keeps the good candidates when one is rejected', () => {
    const { questions, rejectedCount } = validate([
      candidate({ labelRaw: 'Q1' }),
      candidate({ labelRaw: 'Q2', text: '' }),
      candidate({ labelRaw: 'Q3' }),
    ]);

    expect(questions.map((q) => q.labelRaw)).toEqual(['Q1', 'Q3']);
    expect(rejectedCount).toBe(1);
  });
});

describe('geometry validation', () => {
  it.each([
    ['x above 1', { pageNumber: 1, x: 1.4, y: 0.1, width: 0.2, height: 0.1 }],
    ['negative y', { pageNumber: 1, x: 0.1, y: -0.2, width: 0.2, height: 0.1 }],
    ['NaN width', { pageNumber: 1, x: 0.1, y: 0.1, width: Number.NaN, height: 0.1 }],
    ['Infinite height', { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: Infinity }],
    ['past right edge', { pageNumber: 1, x: 0.8, y: 0.1, width: 0.5, height: 0.1 }],
    ['past bottom edge', { pageNumber: 1, x: 0.1, y: 0.9, width: 0.2, height: 0.4 }],
  ])('rejects a region with %s', (_label, rect) => {
    const { questions, warnings } = validate([candidate({ rects: [rect] })]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/invalid region/);
  });

  it('does not silently clamp out-of-range geometry', () => {
    // Clamping would bury the model's misunderstanding behind a
    // plausible-looking highlight in the wrong place.
    const { questions } = validate([
      candidate({ rects: [{ pageNumber: 1, x: 2, y: 2, width: 2, height: 2 }] }),
    ]);

    expect(questions).toHaveLength(0);
  });

  it('rejects an empty region array', () => {
    const { questions, warnings } = validate([candidate({ rects: [] })]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/no region/);
  });

  it('rejects a zero-area region', () => {
    const { questions, warnings } = validate([
      candidate({ rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0, height: 0.1 }] }),
    ]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/zero-area/);
  });

  it('accepts a region covering the whole page', () => {
    const { questions } = validate([
      candidate({ rects: [{ pageNumber: 1, x: 0, y: 0, width: 1, height: 1 }] }),
    ]);

    expect(questions).toHaveLength(1);
  });
});

describe('page validation', () => {
  it('rejects a page the document does not have', () => {
    const { questions, warnings } = validate([candidate({ pageNumber: 9 })]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.code).toBe('PAGE_OUT_OF_RANGE');
  });

  it('rejects page zero — numbering is 1-based', () => {
    expect(validate([candidate({ pageNumber: 0 })]).questions).toHaveLength(0);
  });

  it('rejects a fractional page number', () => {
    expect(validate([candidate({ pageNumber: 1.5 })]).questions).toHaveLength(0);
  });

  it('rejects a region on a page the document does not have', () => {
    const { questions, warnings } = validate([
      candidate({
        pageNumber: 1,
        rects: [{ pageNumber: 7, x: 0.1, y: 0.1, width: 0.2, height: 0.1 }],
      }),
    ]);

    expect(questions).toHaveLength(0);
    expect(warnings[0]?.code).toBe('PAGE_OUT_OF_RANGE');
  });
});

describe('multi-region and multi-page questions', () => {
  it('keeps several regions on one page', () => {
    const { questions } = validate([
      candidate({
        rects: [
          { pageNumber: 1, x: 0.1, y: 0.2, width: 0.35, height: 0.1 },
          { pageNumber: 1, x: 0.55, y: 0.2, width: 0.35, height: 0.1 },
        ],
      }),
    ]);

    expect(questions[0]!.rects).toHaveLength(2);
    expect(questions[0]!.pageNumbers).toEqual([1]);
  });

  it('records every page a question spans', () => {
    const { questions } = validate([
      candidate({
        pageNumber: 1,
        rects: [
          { pageNumber: 1, x: 0.1, y: 0.8, width: 0.8, height: 0.15 },
          { pageNumber: 2, x: 0.1, y: 0.05, width: 0.8, height: 0.2 },
        ],
      }),
    ]);

    expect(questions[0]!.pageNumber).toBe(1);
    expect(questions[0]!.pageNumbers).toEqual([1, 2]);
    expect(questions[0]!.rects).toHaveLength(2);
  });

  it('deduplicates and sorts the spanned pages', () => {
    const { questions } = validate([
      candidate({
        rects: [
          { pageNumber: 3, x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: 0.1 },
          { pageNumber: 3, x: 0.4, y: 0.1, width: 0.2, height: 0.1 },
        ],
      }),
    ]);

    expect(questions[0]!.pageNumbers).toEqual([1, 3]);
  });
});

describe('sub-questions', () => {
  it('records hierarchy without flattening it into a string', () => {
    const { questions } = validate([
      candidate({ labelRaw: '11', text: 'Consider the diagram below.' }),
      candidate({ labelRaw: '11 (a)', text: 'Explain why plant B is pale.' }),
      candidate({ labelRaw: '11 (b)', text: 'Suggest one measure to help plant B.' }),
    ]);

    expect(questions.map((q) => q.labelRaw)).toEqual(['11', '11 (a)', '11 (b)']);
    expect(questions[0]!.isSubQuestion).toBe(false);
    expect(questions[0]!.parentLabel).toBeNull();
    expect(questions[1]!.isSubQuestion).toBe(true);
    expect(questions[1]!.parentLabel).toBe('11');
    expect(questions[2]!.parentLabel).toBe('11');
  });

  it('treats sub-parts as separate questions, each with its own marks', () => {
    const { questions } = validate([
      candidate({ labelRaw: '11 (a)', marks: 2 }),
      candidate({ labelRaw: '11 (b)', marks: 3 }),
    ]);

    expect(questions).toHaveLength(2);
    expect(questions.map((q) => q.marks)).toEqual([2, 3]);
  });
});

describe('bare sub-parts under a numbered stem', () => {
  function stemAndParts() {
    return validate([
      candidate({
        labelRaw: '6.',
        text: 'A diagram shows two potted plants.',
        marks: null,
        pageNumber: 2,
        rects: [{ pageNumber: 2, x: 0.09, y: 0.10, width: 0.6, height: 0.05 }],
      }),
      candidate({
        labelRaw: '(a)',
        text: 'Explain why plant B is pale.',
        marks: 2,
        pageNumber: 2,
        rects: [{ pageNumber: 2, x: 0.11, y: 0.17, width: 0.5, height: 0.03 }],
      }),
      candidate({
        labelRaw: '(b)',
        text: 'Suggest one measure to help plant B recover.',
        marks: 3,
        pageNumber: 2,
        rects: [{ pageNumber: 2, x: 0.11, y: 0.23, width: 0.5, height: 0.03 }],
      }),
    ]);
  }

  it('attaches them to the stem they sit under', () => {
    const { questions } = stemAndParts();

    expect(questions.map((q) => q.normalizedLabel)).toEqual(['6', '6-a', '6-b']);
    expect(questions[1]!.parentLabel).toBe('6');
    expect(questions[2]!.parentLabel).toBe('6');
    expect(questions[1]!.isSubQuestion).toBe(true);
  });

  it('never alters the printed label', () => {
    const { questions } = stemAndParts();
    expect(questions.map((q) => q.labelRaw)).toEqual(['6.', '(a)', '(b)']);
  });

  it('resolves from page position, not the order the model returned them', () => {
    const forwards = stemAndParts();

    // Reversing the model's array must not change the outcome: parenting
    // comes from where things sit on the page, not from array index.
    const reversed = validate([
      candidate({
        labelRaw: '(b)',
        text: 'Suggest one measure to help plant B recover.',
        marks: 3,
        pageNumber: 2,
        rects: [{ pageNumber: 2, x: 0.11, y: 0.23, width: 0.5, height: 0.03 }],
      }),
      candidate({
        labelRaw: '(a)',
        text: 'Explain why plant B is pale.',
        marks: 2,
        pageNumber: 2,
        rects: [{ pageNumber: 2, x: 0.11, y: 0.17, width: 0.5, height: 0.03 }],
      }),
      candidate({
        labelRaw: '6.',
        text: 'A diagram shows two potted plants.',
        marks: null,
        pageNumber: 2,
        rects: [{ pageNumber: 2, x: 0.09, y: 0.10, width: 0.6, height: 0.05 }],
      }),
    ]);

    expect(reversed.questions.map((q) => q.normalizedLabel)).toEqual(
      forwards.questions.map((q) => q.normalizedLabel),
    );
  });

  it('attaches each run of sub-parts to its own stem', () => {
    const { questions } = validate([
      candidate({ labelRaw: '3.', text: 'Stem three.', pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.10, width: 0.5, height: 0.03 }] }),
      candidate({ labelRaw: '(a)', text: 'Three part a.', pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.15, width: 0.5, height: 0.03 }] }),
      candidate({ labelRaw: '6.', text: 'Stem six.', pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.40, width: 0.5, height: 0.03 }] }),
      candidate({ labelRaw: '(a)', text: 'Six part a.', pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.45, width: 0.5, height: 0.03 }] }),
    ]);

    expect(questions.map((q) => q.normalizedLabel)).toEqual(['3', '3-a', '6', '6-a']);
  });

  it('leaves an orphan with no preceding stem unattached', () => {
    const { questions } = validate([
      candidate({
        labelRaw: '(a)',
        text: 'Orphaned sub-part.',
        pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0.5, height: 0.03 }],
      }),
    ]);

    expect(questions[0]!.parentLabel).toBeNull();
    expect(questions[0]!.sortKey.major).toBe(0);
  });
});

describe('deterministic ordering', () => {
  it('sorts by parsed label, not by the order the model returned', () => {
    const { questions } = validate([
      candidate({ labelRaw: 'Q10' }),
      candidate({ labelRaw: 'Q2' }),
      candidate({ labelRaw: 'Q1' }),
    ]);

    expect(questions.map((q) => q.labelRaw)).toEqual(['Q1', 'Q2', 'Q10']);
  });

  it('produces the same order however the candidates arrive', () => {
    const labels = ['4 (b)', '1', '4 (a)', '2', '10'];
    const forwards = validate(labels.map((labelRaw) => candidate({ labelRaw })));
    const backwards = validate(
      [...labels].reverse().map((labelRaw) => candidate({ labelRaw })),
    );

    expect(forwards.questions.map((q) => q.labelRaw)).toEqual([
      '1',
      '2',
      '4 (a)',
      '4 (b)',
      '10',
    ]);
    expect(backwards.questions.map((q) => q.labelRaw)).toEqual(
      forwards.questions.map((q) => q.labelRaw),
    );
  });
});

describe('duplicate detection', () => {
  it('reports a repeated label instead of discarding one', () => {
    const { questions, warnings } = validate([
      candidate({ labelRaw: 'Q1' }),
      candidate({ labelRaw: 'Q2', text: 'First version.' }),
      candidate({ labelRaw: 'Q2', text: 'Second version.' }),
      candidate({ labelRaw: 'Q3' }),
    ]);

    // Both survive — losing one would lose a real question.
    expect(questions).toHaveLength(4);

    const duplicate = warnings.find((warning) => warning.code === 'DUPLICATE_LABEL');
    expect(duplicate).toBeDefined();
    expect(duplicate?.message).toMatch(/appears 2 times/);
    expect(duplicate?.labelRaw).toBe('Q2');
  });

  it('never renumbers to hide the clash', () => {
    const { questions } = validate([
      candidate({ labelRaw: 'Q2' }),
      candidate({ labelRaw: 'Q2' }),
    ]);

    expect(questions.map((q) => q.labelRaw)).toEqual(['Q2', 'Q2']);
    expect(questions.map((q) => q.normalizedLabel)).toEqual(['2', '2']);
  });

  it('treats different spellings of one label as the same identity', () => {
    const { warnings } = validate([
      candidate({ labelRaw: 'Q4' }),
      candidate({ labelRaw: '4.' }),
    ]);

    expect(warnings.some((warning) => warning.code === 'DUPLICATE_LABEL')).toBe(true);
  });

  it('does not flag distinct sub-parts as duplicates', () => {
    const { warnings } = validate([
      candidate({ labelRaw: '4 (a)' }),
      candidate({ labelRaw: '4 (b)' }),
    ]);

    expect(warnings.filter((warning) => warning.code === 'DUPLICATE_LABEL')).toHaveLength(0);
  });
});

describe('empty input', () => {
  it('returns nothing without complaining', () => {
    const outcome = validate([]);

    expect(outcome.questions).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.rejectedCount).toBe(0);
  });
});

describe('unnumbered labels in reading order', () => {
  function paperWithAlternatives() {
    return validate([
      candidate({
        labelRaw: '1.',
        text: 'Given that HCF (156, 78) = 78, LCM (156, 78) is',
        marks: 1,
        pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.05, y: 0.31, width: 0.4, height: 0.05 }],
      }),
      candidate({
        labelRaw: '4.',
        text: 'The discriminant of the quadratic equation is',
        marks: 1,
        pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.05, y: 0.62, width: 0.4, height: 0.05 }],
      }),
      candidate({
        labelRaw: 'OR',
        text: 'Roots of the quadratic equation are',
        marks: 1,
        pageNumber: 1,
        rects: [{ pageNumber: 1, x: 0.05, y: 0.70, width: 0.4, height: 0.05 }],
      }),
      candidate({
        labelRaw: '22.',
        text: 'Find the value of angle Y.',
        marks: 2,
        pageNumber: 3,
        rects: [{ pageNumber: 3, x: 0.05, y: 0.40, width: 0.9, height: 0.05 }],
      }),
      candidate({
        labelRaw: 'OR',
        text: 'If the areas of two similar triangles are equal, show that they are congruent.',
        marks: null,
        pageNumber: 3,
        rects: [{ pageNumber: 3, x: 0.05, y: 0.48, width: 0.9, height: 0.04 }],
      }),
    ]);
  }

  /*
   * A bare "OR" parses to major 0, which sorted every alternative in the paper
   * ahead of question 1 — the teacher's list opened on an answer to something
   * they had not read yet.
   */
  it('sorts an alternative directly after the question it belongs to', () => {
    const { questions } = paperWithAlternatives();

    expect(questions.map((q) => q.labelRaw)).toEqual(['1.', '4.', 'OR', '22.', 'OR']);
  });

  it('leaves the printed label and the matching key alone', () => {
    const { questions } = paperWithAlternatives();
    const alternative = questions[2]!;

    expect(alternative.labelRaw).toBe('OR');
    expect(alternative.normalizedLabel).toBe('or');
    expect(alternative.parentLabel).toBeNull();
    expect(alternative.isSubQuestion).toBe(false);
  });
});
