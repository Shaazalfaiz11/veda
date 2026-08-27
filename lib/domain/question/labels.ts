/**
 * Question label parsing.
 *
 * A printed paper writes the same question a dozen ways — `Q4`, `Question 4`,
 * `4.`, `4)`, `4 (a)`, `(iii)`. Two derived forms are needed, and they serve
 * different jobs:
 *
 *   labelRaw        what the paper shows. Never altered, always what the UI
 *                   renders. Our parse being imperfect must not change what
 *                   the teacher reads.
 *
 *   normalizedLabel a canonical matching key — `4`, `4a`, `4a-iii`. The
 *                   future mapper compares a student's handwritten `Q4(a)`
 *                   against this, so both sides must normalise identically.
 *
 *   sortKey         a structured form used only for deterministic ordering.
 *
 * Keeping display and matching separate is what lets the mapper be aggressive
 * about normalisation without ever corrupting the displayed label.
 */

export interface QuestionSortKey {
  /** Top-level number. 0 when the label carries no parseable major part. */
  major: number;
  /** Alphabetic sub-part, lowercased: the `a` of `4(a)`. */
  minor: string | null;
  /** Roman sub-part, lowercased: the `iii` of `4(a)(iii)`. */
  roman: string | null;
}

export interface ParsedLabel {
  sortKey: QuestionSortKey;
  normalizedLabel: string;
  /** Label of the owning major question, e.g. `4` for `4(a)`. Null at top level. */
  parentLabel: string | null;
  isSubQuestion: boolean;
  /**
   * True when the label names a sub-part but prints no owning number — the
   * bare `(a)` / `(iii)` that real papers use under a numbered stem. The
   * owner cannot be known from the label alone, so it is resolved from
   * reading order during validation.
   */
  isOrphanSubPart: boolean;
}

const ROMAN_VALUES: Readonly<Record<string, number>> = {
  i: 1,
  v: 5,
  x: 10,
  l: 50,
  c: 100,
  d: 500,
  m: 1000,
};

/** Strictly roman: `i`, `iv`, `xii`. Deliberately excludes plain `c`/`d`/`m`. */
const ROMAN_PATTERN = /^(?=[ivxlcdm]+$)m*(cm|cd|d?c{0,3})(xc|xl|l?x{0,3})(ix|iv|v?i{0,3})$/;

export function isRomanNumeral(token: string): boolean {
  const lower = token.toLowerCase();
  return lower.length > 0 && ROMAN_PATTERN.test(lower);
}

export function romanToInt(token: string): number {
  const lower = token.toLowerCase();
  let total = 0;

  for (let i = 0; i < lower.length; i += 1) {
    const current = ROMAN_VALUES[lower[i]!] ?? 0;
    const next = ROMAN_VALUES[lower[i + 1]!] ?? 0;
    total += current < next ? -current : current;
  }

  return total;
}

/**
 * Splits a label into its ordered parts.
 *
 * The leading `Q`/`Question`/`Ans` noise word is dropped, then every
 * remaining alphanumeric run is a part. Ambiguity is resolved by position: a
 * bare letter is only a sub-part if a major number already appeared, so `A1`
 * and `1A` do not collapse into the same thing.
 */
function tokenizeLabel(label: string): string[] {
  const stripped = label
    .trim()
    .toLowerCase()
    .replace(/^(?:questions?|ques|qn|q|ans(?:wer)?)\s*[.:)-]?\s*/i, '');

  return stripped.match(/[a-z]+|\d+/g) ?? [];
}

export function parseQuestionLabel(labelRaw: string): ParsedLabel {
  const tokens = tokenizeLabel(labelRaw);

  let major = 0;
  let minor: string | null = null;
  let roman: string | null = null;
  let sawMajor = false;

  for (const token of tokens) {
    if (/^\d+$/.test(token)) {
      if (!sawMajor) {
        major = Number.parseInt(token, 10);
        sawMajor = true;
      }
      continue;
    }

    // A letter before any number is part of the label's prefix, not a
    // sub-part — `A1` is question A1, not sub-part `a` of question 1.
    if (!sawMajor) continue;

    // A single letter reads as an alphabetic sub-part even when it is also a
    // valid roman numeral: `4(i)` after `4(a)` is far more likely to be the
    // ninth sub-part style than a one-character roman.
    if (token.length === 1) {
      if (minor === null) minor = token;
      continue;
    }

    if (isRomanNumeral(token)) {
      if (roman === null) roman = token;
      continue;
    }

    if (minor === null) minor = token;
  }

  // A label with no number at all, but a single letter or roman token, is a
  // sub-part printed under a numbered stem: "(a)", "(iii)".
  let isOrphanSubPart = false;

  if (!sawMajor && tokens.length === 1) {
    const token = tokens[0]!;

    if (token.length === 1 && /^[a-z]$/.test(token)) {
      minor = token;
      isOrphanSubPart = true;
    } else if (isRomanNumeral(token)) {
      roman = token;
      isOrphanSubPart = true;
    }
  }

  const sortKey: QuestionSortKey = { major, minor, roman };
  const isSubQuestion = minor !== null || roman !== null;

  return {
    sortKey,
    normalizedLabel: buildNormalizedLabel(sortKey, labelRaw),
    // An orphan's owner is unknown until reading order resolves it.
    parentLabel: !isSubQuestion || isOrphanSubPart ? null : String(major),
    isSubQuestion,
    isOrphanSubPart,
  };
}

/**
 * Attaches an orphan sub-part to the major question it sits under.
 *
 * `labelRaw` is untouched — the paper printed "(a)" and that is what the
 * teacher sees. Only the derived matching key and hierarchy change, so a
 * student's handwritten "6(a)" can still be matched against it later.
 */
export function withParentMajor(parsed: ParsedLabel, major: number): ParsedLabel {
  if (!parsed.isOrphanSubPart || major <= 0) return parsed;

  const sortKey: QuestionSortKey = { ...parsed.sortKey, major };

  return {
    sortKey,
    normalizedLabel: buildNormalizedLabel(sortKey, ''),
    parentLabel: String(major),
    isSubQuestion: true,
    isOrphanSubPart: false,
  };
}

/**
 * The canonical matching key. Falls back to a slug of the original label when
 * nothing parseable was found, so an unrecognised label still gets a stable
 * key rather than colliding with every other unparseable one on `0`.
 */
function buildNormalizedLabel(sortKey: QuestionSortKey, labelRaw: string): string {
  if (sortKey.major === 0 && sortKey.minor === null && sortKey.roman === null) {
    const slug = labelRaw.toLowerCase().replace(/[^a-z0-9]+/g, '');
    return slug.length > 0 ? slug : 'unlabelled';
  }

  // major 0 is the sentinel for "no owning number known" — an unresolved
  // bare "(a)". It must not leak into the matching key, or an orphan would
  // normalise to "0-a" and never compare equal to the "6-a" it becomes once
  // its parent is known.
  const major = sortKey.major > 0 ? String(sortKey.major) : null;

  return [major, sortKey.minor, sortKey.roman]
    .filter((part): part is string => part !== null && part !== '')
    .join('-');
}

/**
 * Total ordering over questions.
 *
 * Deterministic by construction: every comparison falls through to the
 * original label, so two questions can never compare equal-but-unordered and
 * leave the sort dependent on input order.
 */
export function compareSortKeys(
  a: { sortKey: QuestionSortKey; labelRaw: string },
  b: { sortKey: QuestionSortKey; labelRaw: string },
): number {
  if (a.sortKey.major !== b.sortKey.major) return a.sortKey.major - b.sortKey.major;

  const minor = compareOptional(a.sortKey.minor, b.sortKey.minor, (x, y) =>
    x < y ? -1 : x > y ? 1 : 0,
  );
  if (minor !== 0) return minor;

  const roman = compareOptional(
    a.sortKey.roman,
    b.sortKey.roman,
    (x, y) => romanToInt(x) - romanToInt(y),
  );
  if (roman !== 0) return roman;

  return a.labelRaw.localeCompare(b.labelRaw);
}

/** A missing part sorts before a present one: `4` comes before `4(a)`. */
function compareOptional(
  a: string | null,
  b: string | null,
  compare: (x: string, y: string) => number,
): number {
  if (a === null && b === null) return 0;
  if (a === null) return -1;
  if (b === null) return 1;
  return compare(a, b);
}
