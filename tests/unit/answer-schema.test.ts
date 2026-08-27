import { describe, expect, it } from 'vitest';
import {
  ANSWER_EXTRACTION_PROMPT_VERSION,
  GEMINI_ANSWER_SCHEMA,
  GeminiAnswerResponseSchema,
  buildAnswerExtractionPrompt,
} from '@/lib/providers/ai';

describe('response schema handed to Gemini', () => {
  const answer = GEMINI_ANSWER_SCHEMA.properties?.['answers']?.items;

  it('requires only what the domain needs', () => {
    expect(answer?.required).toEqual(['claimedLabelRaw', 'text', 'regions']);
    expect(Object.keys(answer?.properties ?? {}).sort()).toEqual([
      'claimedLabelRaw',
      'regions',
      'text',
    ]);
  });

  it('gives the model no field in which to record a question mapping', () => {
    // The most reliable way to stop the model deciding a mapping is to leave
    // it nowhere to put one.
    const fields = Object.keys(answer?.properties ?? {});

    expect(fields).not.toContain('questionId');
    expect(fields).not.toContain('questionLabel');
    expect(fields).not.toContain('mappedTo');
    expect(fields).not.toContain('confidence');
  });

  it('allows a null label so an unlabelled answer is expressible', () => {
    expect(answer?.properties?.['claimedLabelRaw']?.nullable).toBe(true);
  });

  it('carries a page number and kind on every region', () => {
    const region = answer?.properties?.['regions']?.items;

    expect(region?.required).toEqual(['pageNumber', 'x', 'y', 'width', 'height', 'kind']);
    expect(region?.properties?.['kind']?.enum).toEqual(['text', 'diagram']);
  });
});

describe('post-hoc response validation', () => {
  const valid = {
    answers: [
      {
        claimedLabelRaw: 'Q1',
        text: 'The chloroplast.',
        regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.05, kind: 'text' }],
      },
    ],
  };

  it('accepts a well-formed response', () => {
    expect(GeminiAnswerResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('accepts an explicitly null label', () => {
    const result = GeminiAnswerResponseSchema.safeParse({
      answers: [{ ...valid.answers[0], claimedLabelRaw: null }],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.answers[0]!.claimedLabelRaw).toBeNull();
  });

  it('treats an omitted label as no label', () => {
    const { claimedLabelRaw: _omitted, ...withoutLabel } = valid.answers[0]!;
    const result = GeminiAnswerResponseSchema.safeParse({ answers: [withoutLabel] });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.answers[0]!.claimedLabelRaw).toBeNull();
  });

  it('discards fields the model invented', () => {
    const result = GeminiAnswerResponseSchema.safeParse({
      answers: [{ ...valid.answers[0], questionId: 'q-1', confidence: 0.9 }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.answers[0]).not.toHaveProperty('questionId');
      expect(result.data.answers[0]).not.toHaveProperty('confidence');
    }
  });

  it('coerces stringified numbers', () => {
    const result = GeminiAnswerResponseSchema.safeParse({
      answers: [
        {
          ...valid.answers[0],
          regions: [
            { pageNumber: '2', x: '0.1', y: '0.2', width: '0.7', height: '0.05', kind: 'text' },
          ],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.answers[0]!.regions[0]!.pageNumber).toBe(2);
      expect(result.data.answers[0]!.regions[0]!.x).toBeCloseTo(0.1);
    }
  });

  it('falls back to text for an unrecognised region kind', () => {
    const result = GeminiAnswerResponseSchema.safeParse({
      answers: [
        {
          ...valid.answers[0],
          regions: [{ pageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.05, kind: 'doodle' }],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.answers[0]!.regions[0]!.kind).toBe('text');
  });

  it('rejects a non-numeric coordinate', () => {
    const result = GeminiAnswerResponseSchema.safeParse({
      answers: [
        {
          ...valid.answers[0],
          regions: [{ pageNumber: 1, x: 'left', y: 0.2, width: 0.7, height: 0.05, kind: 'text' }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative page number', () => {
    expect(
      GeminiAnswerResponseSchema.safeParse({
        answers: [
          {
            ...valid.answers[0],
            regions: [{ pageNumber: 0, x: 0.1, y: 0.2, width: 0.7, height: 0.05, kind: 'text' }],
          },
        ],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing answers array', () => {
    expect(GeminiAnswerResponseSchema.safeParse({}).success).toBe(false);
    expect(GeminiAnswerResponseSchema.safeParse({ answers: 'none' }).success).toBe(false);
  });

  it('leaves the 0-1 range to the validator', () => {
    // Shape and meaning are separate passes; the service rejects out-of-range
    // geometry with a domain-level message.
    const result = GeminiAnswerResponseSchema.safeParse({
      answers: [
        {
          ...valid.answers[0],
          regions: [{ pageNumber: 1, x: 1.4, y: 0.2, width: 0.7, height: 0.05, kind: 'text' }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe('extraction prompt', () => {
  it('is versioned so a change in output can be traced', () => {
    expect(ANSWER_EXTRACTION_PROMPT_VERSION).toBe('answer-extraction/v2');
  });

  it('states the page count and 1-based numbering', () => {
    const prompt = buildAnswerExtractionPrompt(6);

    expect(prompt).toContain('6 page images');
    expect(prompt).toContain('1-based');
  });

  it('uses the singular for a one-page sheet', () => {
    expect(buildAnswerExtractionPrompt(1)).toContain('1 page image,');
  });

  it('forbids inventing unreadable handwriting', () => {
    const prompt = buildAnswerExtractionPrompt(2);

    expect(prompt).toContain('[unclear]');
    expect(prompt).toMatch(/Never substitute a plausible guess/);
  });

  it('explicitly forbids deciding which question an answer belongs to', () => {
    const prompt = buildAnswerExtractionPrompt(2);

    expect(prompt).toMatch(/Do not work out which question an answer belongs to/);
    expect(prompt).toMatch(/do not say which question any answer belongs to/);
  });

  it('tells the model an unlabelled answer is normal', () => {
    const prompt = buildAnswerExtractionPrompt(2);

    expect(prompt).toMatch(/completely normal — still return the answer/);
  });

  it('describes the coordinate convention it expects back', () => {
    const prompt = buildAnswerExtractionPrompt(2);

    expect(prompt).toContain('top-left');
    expect(prompt).toContain('y increases downward');
    expect(prompt).toMatch(/between 0 and 1/);
  });

  it('covers multi-region, multi-page and diagram handling', () => {
    const prompt = buildAnswerExtractionPrompt(2);

    expect(prompt).toMatch(/Return several regions when one answer occupies separate areas/);
    expect(prompt).toMatch(/ONE answer with regions on both pages/);
    expect(prompt).toMatch(/Do not attempt to reproduce the drawing itself/);
  });

  it('separates student work from everything else on the page', () => {
    const prompt = buildAnswerExtractionPrompt(2);

    expect(prompt).toMatch(/written by a teacher in the margin/);
    expect(prompt).toMatch(/Printed text from the question paper/);
  });
});
