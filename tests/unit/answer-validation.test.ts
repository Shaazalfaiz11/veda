import { describe, expect, it } from 'vitest';
import { validateAnswerCandidates } from '@/lib/services/answer/answer-validation';
import { UNCLEAR_MARKER } from '@/lib/domain/answer';
import type { ExtractedAnswerCandidate } from '@/lib/providers/ai';

const PAGES = [1, 2, 3];

function candidate(
  overrides: Partial<ExtractedAnswerCandidate> = {},
): ExtractedAnswerCandidate {
  return {
    claimedLabelRaw: 'Q1',
    text: 'Photosynthesis occurs in the chloroplast.',
    regions: [{ pageNumber: 1, x: 0.08, y: 0.2, width: 0.8, height: 0.1, kind: 'text' }],
    ...overrides,
  };
}

function validate(candidates: ExtractedAnswerCandidate[]) {
  return validateAnswerCandidates({ candidates, availablePageNumbers: PAGES });
}

describe('basic extraction', () => {
  it('produces a domain answer with a server-generated id', () => {
    const { answers } = validate([candidate()]);

    expect(answers).toHaveLength(1);
    expect(answers[0]!.id).toMatch(/^[0-9a-f-]{36}$/);
    expect(answers[0]!.text).toBe('Photosynthesis occurs in the chloroplast.');
    expect(answers[0]!.pageNumbers).toEqual([1]);
  });

  it('keeps several distinct answers', () => {
    const { answers } = validate([
      candidate({ claimedLabelRaw: 'Q1', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: 'Q2', regions: [region(1, 0.4)] }),
      candidate({ claimedLabelRaw: 'Q3', regions: [region(1, 0.7)] }),
    ]);

    expect(answers.map((a) => a.claimedLabelRaw)).toEqual(['Q1', 'Q2', 'Q3']);
    expect(new Set(answers.map((a) => a.id)).size).toBe(3);
  });

  it('never attaches a question reference', () => {
    // The whole point of this phase: an answer does not know its question.
    const { answers } = validate([candidate({ claimedLabelRaw: 'Q4' })]);
    const answer = answers[0]! as unknown as Record<string, unknown>;

    expect(answer['questionId']).toBeUndefined();
    expect(answer['parentQuestionId']).toBeUndefined();
    expect(answer['mappedQuestion']).toBeUndefined();
  });

  it('trims whitespace from the transcription and the label', () => {
    const { answers } = validate([
      candidate({ claimedLabelRaw: '  Q2  ', text: '  Some working.  ' }),
    ]);

    expect(answers[0]!.claimedLabelRaw).toBe('Q2');
    expect(answers[0]!.text).toBe('Some working.');
  });
});

describe('claimed labels', () => {
  it('preserves the exact written form and derives a matching key', () => {
    const { answers } = validate([candidate({ claimedLabelRaw: 'Q2' })]);

    expect(answers[0]!.claimedLabelRaw).toBe('Q2');
    expect(answers[0]!.claimedLabelNormalized).toBe('2');
  });

  it.each([
    ['Q1', '1'],
    ['2.', '2'],
    ['Ans 3', '3'],
    ['4(b)', '4-b'],
  ])('normalises %s to %s', (written, normalized) => {
    const { answers } = validate([candidate({ claimedLabelRaw: written })]);
    expect(answers[0]!.claimedLabelNormalized).toBe(normalized);
  });

  it('normalises a bare "(a)" to "a" and stops there', () => {
    // Resolving which question owns it needs evidence this phase does not
    // have; that decision belongs to the mapping stage.
    const { answers } = validate([candidate({ claimedLabelRaw: '(a)' })]);

    expect(answers[0]!.claimedLabelRaw).toBe('(a)');
    expect(answers[0]!.claimedLabelNormalized).toBe('a');

    const answer = answers[0]! as unknown as Record<string, unknown>;
    expect(answer['parentQuestionId']).toBeUndefined();
    expect(answer['parentLabel']).toBeUndefined();
  });

  it('matches the key a question label normalises to', () => {
    // Both sides must normalise identically for the mapper to compare them.
    const { answers } = validate([candidate({ claimedLabelRaw: 'Q4(b)' })]);
    expect(answers[0]!.claimedLabelNormalized).toBe('4-b');
  });
});

describe('unlabelled answers', () => {
  it('keeps an answer the student did not label', () => {
    const { answers } = validate([candidate({ claimedLabelRaw: null })]);

    expect(answers).toHaveLength(1);
    expect(answers[0]!.claimedLabelRaw).toBeNull();
    expect(answers[0]!.claimedLabelNormalized).toBeNull();
  });

  it('treats an empty-string label as no label', () => {
    const { answers } = validate([candidate({ claimedLabelRaw: '   ' })]);
    expect(answers[0]!.claimedLabelRaw).toBeNull();
  });

  it('reports how many are unlabelled without treating it as a defect', () => {
    const { answers, warnings, rejectedCount } = validate([
      candidate({ claimedLabelRaw: null, regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: null, regions: [region(1, 0.5)] }),
    ]);

    expect(answers).toHaveLength(2);
    expect(rejectedCount).toBe(0);

    const warning = warnings.find((w) => w.code === 'NO_LABEL');
    expect(warning?.message).toMatch(/2 answers carry no written question label/);
  });
});

describe('regions', () => {
  it('keeps several regions for one answer', () => {
    const { answers } = validate([
      candidate({
        regions: [
          { pageNumber: 1, x: 0.1, y: 0.2, width: 0.8, height: 0.08, kind: 'text' },
          { pageNumber: 1, x: 0.2, y: 0.32, width: 0.5, height: 0.2, kind: 'diagram' },
          { pageNumber: 1, x: 0.1, y: 0.55, width: 0.8, height: 0.06, kind: 'text' },
        ],
      }),
    ]);

    // Not collapsed into one box that would swallow the gaps between them.
    expect(answers[0]!.regions).toHaveLength(3);
    expect(answers[0]!.containsDiagram).toBe(true);
  });

  it('marks an answer with no diagram region accordingly', () => {
    expect(validate([candidate()]).answers[0]!.containsDiagram).toBe(false);
  });

  it('defaults an unrecognised region kind to text rather than rejecting', () => {
    const { answers } = validate([
      candidate({
        regions: [
          { pageNumber: 1, x: 0.1, y: 0.2, width: 0.5, height: 0.1, kind: 'scribble' as never },
        ],
      }),
    ]);

    // The geometry is the valuable part; a mislabelled kind costs far less
    // than discarding a located answer.
    expect(answers[0]!.regions[0]!.kind).toBe('text');
  });

  it('rejects an answer with no regions', () => {
    const { answers, warnings } = validate([candidate({ regions: [] })]);

    expect(answers).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/no region/);
  });
});

describe('multi-page answers', () => {
  it('keeps one answer spanning two pages', () => {
    const { answers } = validate([
      candidate({
        claimedLabelRaw: 'Q4',
        regions: [
          { pageNumber: 1, x: 0.1, y: 0.75, width: 0.8, height: 0.2, kind: 'text' },
          { pageNumber: 2, x: 0.1, y: 0.05, width: 0.8, height: 0.25, kind: 'text' },
        ],
      }),
    ]);

    expect(answers).toHaveLength(1);
    expect(answers[0]!.pageNumbers).toEqual([1, 2]);
    expect(answers[0]!.spansPages).toBe(true);
  });

  it('does not flag a single-page answer as spanning', () => {
    expect(validate([candidate()]).answers[0]!.spansPages).toBe(false);
  });

  it('deduplicates and sorts the pages it touches', () => {
    const { answers } = validate([
      candidate({
        regions: [
          { pageNumber: 3, x: 0.1, y: 0.1, width: 0.4, height: 0.1, kind: 'text' },
          { pageNumber: 1, x: 0.1, y: 0.1, width: 0.4, height: 0.1, kind: 'text' },
          { pageNumber: 3, x: 0.1, y: 0.3, width: 0.4, height: 0.1, kind: 'text' },
        ],
      }),
    ]);

    expect(answers[0]!.pageNumbers).toEqual([1, 3]);
  });
});

describe('geometry validation', () => {
  it.each([
    ['x above 1', { pageNumber: 1, x: 1.4, y: 0.1, width: 0.2, height: 0.1, kind: 'text' }],
    ['negative y', { pageNumber: 1, x: 0.1, y: -0.2, width: 0.2, height: 0.1, kind: 'text' }],
    ['NaN width', { pageNumber: 1, x: 0.1, y: 0.1, width: Number.NaN, height: 0.1, kind: 'text' }],
    ['Infinite height', { pageNumber: 1, x: 0.1, y: 0.1, width: 0.2, height: Infinity, kind: 'text' }],
    ['past right edge', { pageNumber: 1, x: 0.8, y: 0.1, width: 0.5, height: 0.1, kind: 'text' }],
    ['past bottom edge', { pageNumber: 1, x: 0.1, y: 0.9, width: 0.2, height: 0.4, kind: 'text' }],
  ])('rejects a region with %s', (_label, region) => {
    const { answers, warnings } = validate([
      candidate({ regions: [region as ExtractedAnswerCandidate['regions'][number]] }),
    ]);

    expect(answers).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/invalid region/);
  });

  it('does not silently clamp out-of-range geometry', () => {
    const { answers } = validate([
      candidate({
        regions: [{ pageNumber: 1, x: 2, y: 2, width: 2, height: 2, kind: 'text' }],
      }),
    ]);

    expect(answers).toHaveLength(0);
  });

  it('rejects a zero-area region', () => {
    const { answers, warnings } = validate([
      candidate({
        regions: [{ pageNumber: 1, x: 0.1, y: 0.1, width: 0, height: 0.1, kind: 'text' }],
      }),
    ]);

    expect(answers).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/zero-area/);
  });
});

describe('page validation', () => {
  it('rejects a page the answer sheet does not have', () => {
    const { answers, warnings } = validate([candidate({ regions: [region(9, 0.1)] })]);

    expect(answers).toHaveLength(0);
    expect(warnings[0]?.code).toBe('PAGE_OUT_OF_RANGE');
  });

  it('rejects page zero — numbering is 1-based', () => {
    expect(validate([candidate({ regions: [region(0, 0.1)] })]).answers).toHaveLength(0);
  });

  it('rejects a fractional page number', () => {
    expect(validate([candidate({ regions: [region(1.5, 0.1)] })]).answers).toHaveLength(0);
  });
});

describe('malformed candidates', () => {
  it('rejects an answer with no transcription', () => {
    const { answers, warnings } = validate([candidate({ text: '' })]);

    expect(answers).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/no transcribed text/);
  });

  it('rejects a whitespace-only transcription', () => {
    expect(validate([candidate({ text: '   \n  ' })]).answers).toHaveLength(0);
  });

  /**
   * Seen against a real paper: the model returned one "answer" whose entire
   * text was the unclear marker. It passed the empty check, reached the
   * mapper, and produced a graded record standing for nothing.
   */
  it('rejects a transcription that is nothing but unclear markers', () => {
    const { answers, warnings } = validate([candidate({ text: '[unclear]' })]);

    expect(answers).toHaveLength(0);
    expect(warnings[0]?.message).toMatch(/unreadable in its entirety/);
  });

  it('rejects repeated unclear markers with only whitespace between them', () => {
    expect(
      validate([candidate({ text: '[unclear]  [unclear]\n[unclear]' })]).answers,
    ).toHaveLength(0);
  });

  /** The marker exists to preserve partly legible work, so this must survive. */
  it('keeps an answer that is only partly unreadable', () => {
    const { answers } = validate([
      candidate({ text: 'Force equals [unclear] times acceleration.' }),
    ]);

    expect(answers).toHaveLength(1);
    expect(answers[0]?.hasUncertainSegments).toBe(true);
  });

  it('keeps the good candidates when one is rejected', () => {
    const { answers, rejectedCount } = validate([
      candidate({ claimedLabelRaw: 'Q1', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: 'Q2', text: '' }),
      candidate({ claimedLabelRaw: 'Q3', regions: [region(1, 0.6)] }),
    ]);

    expect(answers.map((a) => a.claimedLabelRaw)).toEqual(['Q1', 'Q3']);
    expect(rejectedCount).toBe(1);
  });
});

describe('uncertain handwriting', () => {
  it('flags a transcription that admits an illegible stretch', () => {
    const { answers, warnings } = validate([
      candidate({ text: `The process occurs in the ${UNCLEAR_MARKER} of the cell.` }),
    ]);

    expect(answers[0]!.hasUncertainSegments).toBe(true);
    expect(warnings.some((w) => w.code === 'UNCERTAIN_TRANSCRIPTION')).toBe(true);
  });

  it('keeps the marker in the text rather than stripping it', () => {
    const { answers } = validate([candidate({ text: `Answer is ${UNCLEAR_MARKER}.` })]);
    expect(answers[0]!.text).toContain(UNCLEAR_MARKER);
  });

  it('does not flag a clean transcription', () => {
    const { answers, warnings } = validate([candidate()]);

    expect(answers[0]!.hasUncertainSegments).toBe(false);
    expect(warnings.some((w) => w.code === 'UNCERTAIN_TRANSCRIPTION')).toBe(false);
  });
});

describe('deterministic ordering', () => {
  it('orders by page, then vertical position', () => {
    const { answers } = validate([
      candidate({ claimedLabelRaw: 'third', regions: [region(2, 0.1)] }),
      candidate({ claimedLabelRaw: 'second', regions: [region(1, 0.6)] }),
      candidate({ claimedLabelRaw: 'first', regions: [region(1, 0.1)] }),
    ]);

    expect(answers.map((a) => a.claimedLabelRaw)).toEqual(['first', 'second', 'third']);
    expect(answers.map((a) => a.documentPosition)).toEqual([0, 1, 2]);
  });

  it('produces the same order however the candidates arrive', () => {
    const build = () => [
      candidate({ claimedLabelRaw: 'a', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: 'b', regions: [region(1, 0.5)] }),
      candidate({ claimedLabelRaw: 'c', regions: [region(2, 0.2)] }),
    ];

    const forwards = validate(build());
    const backwards = validate(build().reverse());

    expect(backwards.answers.map((a) => a.claimedLabelRaw)).toEqual(
      forwards.answers.map((a) => a.claimedLabelRaw),
    );
  });

  it('orders a multi-page answer by the first page it touches', () => {
    const { answers } = validate([
      candidate({ claimedLabelRaw: 'later', regions: [region(2, 0.5)] }),
      candidate({
        claimedLabelRaw: 'spanning',
        regions: [region(1, 0.8), region(2, 0.05)],
      }),
    ]);

    expect(answers.map((a) => a.claimedLabelRaw)).toEqual(['spanning', 'later']);
  });

  it('records position as metadata, not as a mapping decision', () => {
    const { answers } = validate([
      candidate({ claimedLabelRaw: 'Q7', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: 'Q2', regions: [region(1, 0.5)] }),
    ]);

    // Out-of-order labels are left exactly as written; position does not
    // reorder or reinterpret them.
    expect(answers.map((a) => a.claimedLabelRaw)).toEqual(['Q7', 'Q2']);
    expect(answers.map((a) => a.documentPosition)).toEqual([0, 1]);
  });
});

describe('duplicate claimed labels', () => {
  it('keeps both and reports the clash', () => {
    const { answers, warnings } = validate([
      candidate({ claimedLabelRaw: 'Q2', text: 'First attempt.', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: 'Q2', text: 'Second attempt.', regions: [region(2, 0.1)] }),
    ]);

    expect(answers).toHaveLength(2);

    const warning = warnings.find((w) => w.code === 'DUPLICATE_CLAIMED_LABEL');
    expect(warning?.message).toMatch(/2 answers claim label "2"/);
    expect(warning?.message).toMatch(/none were merged/);
  });

  it('does not merge them into one answer', () => {
    const { answers } = validate([
      candidate({ claimedLabelRaw: 'Q2', text: 'First.', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: 'Q2', text: 'Second.', regions: [region(1, 0.5)] }),
    ]);

    expect(answers.map((a) => a.text)).toEqual(['First.', 'Second.']);
    expect(answers[0]!.regions).toHaveLength(1);
  });

  it('does not treat unlabelled answers as duplicates of each other', () => {
    const { warnings } = validate([
      candidate({ claimedLabelRaw: null, regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: null, regions: [region(1, 0.5)] }),
    ]);

    expect(warnings.filter((w) => w.code === 'DUPLICATE_CLAIMED_LABEL')).toHaveLength(0);
  });

  it('catches duplicates written in different forms', () => {
    const { warnings } = validate([
      candidate({ claimedLabelRaw: 'Q2', regions: [region(1, 0.1)] }),
      candidate({ claimedLabelRaw: '2.', regions: [region(1, 0.5)] }),
    ]);

    expect(warnings.some((w) => w.code === 'DUPLICATE_CLAIMED_LABEL')).toBe(true);
  });
});

describe('empty input', () => {
  it('returns nothing without complaining', () => {
    const outcome = validate([]);

    expect(outcome.answers).toEqual([]);
    expect(outcome.warnings).toEqual([]);
    expect(outcome.rejectedCount).toBe(0);
  });
});

function region(pageNumber: number, y: number) {
  return { pageNumber, x: 0.1, y, width: 0.7, height: 0.08, kind: 'text' as const };
}
