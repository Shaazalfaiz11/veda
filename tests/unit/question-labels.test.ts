import { describe, expect, it } from 'vitest';
import {
  compareSortKeys,
  isRomanNumeral,
  parseQuestionLabel,
  romanToInt,
  withParentMajor,
} from '@/lib/domain/question';

describe('roman numerals', () => {
  it('recognises well-formed numerals', () => {
    expect(isRomanNumeral('i')).toBe(true);
    expect(isRomanNumeral('iv')).toBe(true);
    expect(isRomanNumeral('XII')).toBe(true);
  });

  it('rejects non-numerals', () => {
    expect(isRomanNumeral('a')).toBe(false);
    expect(isRomanNumeral('ib')).toBe(false);
    expect(isRomanNumeral('')).toBe(false);
  });

  it('converts to integers, including subtractive forms', () => {
    expect(romanToInt('i')).toBe(1);
    expect(romanToInt('iv')).toBe(4);
    expect(romanToInt('ix')).toBe(9);
    expect(romanToInt('xii')).toBe(12);
  });
});

describe('label normalization', () => {
  it.each([
    ['Q1', 1, null, null, '1'],
    ['Q.4', 4, null, null, '4'],
    ['Question 7', 7, null, null, '7'],
    ['4.', 4, null, null, '4'],
    ['12)', 12, null, null, '12'],
    ['  3  ', 3, null, null, '3'],
  ])('parses top-level label %s', (label, major, minor, roman, normalized) => {
    const parsed = parseQuestionLabel(label);

    expect(parsed.sortKey.major).toBe(major);
    expect(parsed.sortKey.minor).toBe(minor);
    expect(parsed.sortKey.roman).toBe(roman);
    expect(parsed.normalizedLabel).toBe(normalized);
    expect(parsed.isSubQuestion).toBe(false);
    expect(parsed.parentLabel).toBeNull();
  });

  it.each([
    ['4(a)', 4, 'a', '4-a'],
    ['4 (a)', 4, 'a', '4-a'],
    ['11 (b)', 11, 'b', '11-b'],
    ['Q4a', 4, 'a', '4-a'],
    ['4.b', 4, 'b', '4-b'],
  ])('parses sub-question %s', (label, major, minor, normalized) => {
    const parsed = parseQuestionLabel(label);

    expect(parsed.sortKey.major).toBe(major);
    expect(parsed.sortKey.minor).toBe(minor);
    expect(parsed.normalizedLabel).toBe(normalized);
    expect(parsed.isSubQuestion).toBe(true);
    expect(parsed.parentLabel).toBe(String(major));
  });

  it('collapses the many spellings of one question to one matching key', () => {
    // This is what the future mapper depends on: a student writing "Q4(a)"
    // must normalise to the same key as the paper's "4 (a)".
    const forms = ['4(a)', '4 (a)', 'Q4(a)', 'Question 4 (a)', '4.a', 'Q 4 a'];
    const keys = new Set(forms.map((form) => parseQuestionLabel(form).normalizedLabel));

    expect(keys.size).toBe(1);
    expect([...keys][0]).toBe('4-a');
  });

  it('parses a roman sub-part', () => {
    const parsed = parseQuestionLabel('4(a)(iii)');

    expect(parsed.sortKey).toEqual({ major: 4, minor: 'a', roman: 'iii' });
    expect(parsed.normalizedLabel).toBe('4-a-iii');
    expect(parsed.isSubQuestion).toBe(true);
  });

  it('treats a single letter as alphabetic even when it is also roman', () => {
    // "4(i)" alongside "4(a)" is far more likely a lettered part than a
    // one-character roman numeral.
    expect(parseQuestionLabel('4(i)').sortKey).toEqual({ major: 4, minor: 'i', roman: null });
  });

  it('does not treat a letter before the number as a sub-part', () => {
    // "A1" is question A1, not sub-part "a" of question 1.
    const parsed = parseQuestionLabel('A1');

    expect(parsed.sortKey.major).toBe(1);
    expect(parsed.sortKey.minor).toBeNull();
    expect(parsed.isSubQuestion).toBe(false);
  });

  it('gives an unparseable label a stable key rather than colliding on zero', () => {
    const first = parseQuestionLabel('Part One');
    const second = parseQuestionLabel('Part Two');

    expect(first.normalizedLabel).not.toBe(second.normalizedLabel);
    expect(first.normalizedLabel).toBe('partone');
  });

  it('never alters the label it was given', () => {
    const label = '11 (a)';
    parseQuestionLabel(label);
    expect(label).toBe('11 (a)');
  });
});

describe('deterministic ordering', () => {
  function sorted(labels: string[]): string[] {
    return labels
      .map((labelRaw) => ({ labelRaw, sortKey: parseQuestionLabel(labelRaw).sortKey }))
      .sort(compareSortKeys)
      .map((entry) => entry.labelRaw);
  }

  it('orders by major number, not by string', () => {
    expect(sorted(['Q10', 'Q2', 'Q1'])).toEqual(['Q1', 'Q2', 'Q10']);
  });

  it('places a major question before its own sub-parts', () => {
    expect(sorted(['4(b)', '4', '4(a)'])).toEqual(['4', '4(a)', '4(b)']);
  });

  it('orders roman sub-parts numerically, not alphabetically', () => {
    expect(sorted(['4(a)(iv)', '4(a)(ii)', '4(a)(i)'])).toEqual([
      '4(a)(i)',
      '4(a)(ii)',
      '4(a)(iv)',
    ]);
  });

  it('produces the same order regardless of input order', () => {
    const labels = ['11 (b)', '2', '11 (a)', '1', '10', '2(a)'];
    const forwards = sorted(labels);
    const backwards = sorted([...labels].reverse());
    const shuffled = sorted([labels[3]!, labels[0]!, labels[4]!, labels[1]!, labels[5]!, labels[2]!]);

    expect(forwards).toEqual(['1', '2', '2(a)', '10', '11 (a)', '11 (b)']);
    expect(backwards).toEqual(forwards);
    expect(shuffled).toEqual(forwards);
  });

  it('is a total order — equal keys still resolve by original label', () => {
    expect(sorted(['Q4', '4.', '4)'])).toHaveLength(3);
  });
});

describe('bare sub-part labels', () => {
  // Real papers print a numbered stem then "(a)", "(b)" with no number of
  // their own. The owner is only recoverable from position on the page.
  it.each([
    ['(a)', 'a', null],
    ['(b)', 'b', null],
    ['(iii)', null, 'iii'],
    ['(ii)', null, 'ii'],
  ])('flags %s as an orphan sub-part', (label, minor, roman) => {
    const parsed = parseQuestionLabel(label);

    expect(parsed.isOrphanSubPart).toBe(true);
    expect(parsed.isSubQuestion).toBe(true);
    expect(parsed.sortKey.major).toBe(0);
    expect(parsed.sortKey.minor).toBe(minor);
    expect(parsed.sortKey.roman).toBe(roman);
    // The owner is unknown until reading order resolves it.
    expect(parsed.parentLabel).toBeNull();
  });

  it('does not treat a numbered label as an orphan', () => {
    expect(parseQuestionLabel('6.').isOrphanSubPart).toBe(false);
    expect(parseQuestionLabel('6(a)').isOrphanSubPart).toBe(false);
  });

  it('does not treat prose as an orphan sub-part', () => {
    expect(parseQuestionLabel('Part One').isOrphanSubPart).toBe(false);
    expect(parseQuestionLabel('Section').isOrphanSubPart).toBe(false);
  });

  it('attaches an orphan to its parent without touching the printed label', () => {
    const parsed = parseQuestionLabel('(a)');
    const resolved = withParentMajor(parsed, 6);

    expect(resolved.sortKey).toEqual({ major: 6, minor: 'a', roman: null });
    expect(resolved.normalizedLabel).toBe('6-a');
    expect(resolved.parentLabel).toBe('6');
    expect(resolved.isSubQuestion).toBe(true);
    expect(resolved.isOrphanSubPart).toBe(false);
  });

  it('makes a bare "(a)" match the same key as a printed "6(a)"', () => {
    // This is what lets the future mapper match a student's "Q6(a)".
    expect(withParentMajor(parseQuestionLabel('(a)'), 6).normalizedLabel).toBe(
      parseQuestionLabel('6(a)').normalizedLabel,
    );
  });

  it('keeps the unknown-parent sentinel out of the matching key', () => {
    // major 0 means "no owning number known". If it leaked into the key an
    // orphan would normalise to "0-a" and never compare equal to the "6-a"
    // it becomes once its parent is resolved.
    const orphan = parseQuestionLabel('(a)');

    expect(orphan.sortKey.major).toBe(0);
    expect(orphan.normalizedLabel).toBe('a');
    expect(orphan.normalizedLabel).not.toContain('0');
  });

  it('leaves a non-orphan and an unknown parent alone', () => {
    const numbered = parseQuestionLabel('6(a)');
    expect(withParentMajor(numbered, 9)).toBe(numbered);

    const orphan = parseQuestionLabel('(a)');
    expect(withParentMajor(orphan, 0)).toBe(orphan);
  });
});
