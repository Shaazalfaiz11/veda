import { describe, expect, it } from 'vitest';
import {
  GEMINI_QUESTION_SCHEMA,
  GeminiQuestionResponseSchema,
  buildQuestionExtractionPrompt,
  classifyGeminiError,
  QUESTION_EXTRACTION_PROMPT_VERSION,
} from '@/lib/providers/ai';

describe('response schema handed to Gemini', () => {
  it('requires the fields the domain needs and nothing else', () => {
    const question = GEMINI_QUESTION_SCHEMA.properties?.['questions']?.items;

    expect(question?.required).toEqual(['labelRaw', 'text', 'marks', 'pageNumber', 'rects']);
    expect(Object.keys(question?.properties ?? {}).sort()).toEqual([
      'labelRaw',
      'marks',
      'pageNumber',
      'rects',
      'text',
    ]);
  });

  it('allows marks to be null so the model is not forced to invent one', () => {
    const marks = GEMINI_QUESTION_SCHEMA.properties?.['questions']?.items?.properties?.['marks'];
    expect(marks?.nullable).toBe(true);
  });

  it('carries a page number on every region, for multi-page questions', () => {
    const rect = GEMINI_QUESTION_SCHEMA.properties?.['questions']?.items?.properties?.['rects']
      ?.items;

    expect(rect?.required).toEqual(['rectPageNumber', 'x', 'y', 'width', 'height']);
  });
});

describe('post-hoc response validation', () => {
  const valid = {
    questions: [
      {
        labelRaw: 'Q1',
        text: 'Explain photosynthesis.',
        marks: 5,
        pageNumber: 1,
        rects: [{ rectPageNumber: 1, x: 0.1, y: 0.2, width: 0.7, height: 0.05 }],
      },
    ],
  };

  it('accepts a well-formed response', () => {
    expect(GeminiQuestionResponseSchema.safeParse(valid).success).toBe(true);
  });

  it('discards fields the model invented', () => {
    const result = GeminiQuestionResponseSchema.safeParse({
      questions: [{ ...valid.questions[0], confidence: 0.9, id: 'model-id' }],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions[0]).not.toHaveProperty('confidence');
      expect(result.data.questions[0]).not.toHaveProperty('id');
    }
  });

  it('coerces a stringified number, which models sometimes emit', () => {
    const result = GeminiQuestionResponseSchema.safeParse({
      questions: [
        {
          ...valid.questions[0],
          marks: '5',
          pageNumber: '1',
          rects: [{ rectPageNumber: '1', x: '0.1', y: '0.2', width: '0.7', height: '0.05' }],
        },
      ],
    });

    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.questions[0]!.marks).toBe(5);
      expect(result.data.questions[0]!.rects[0]!.x).toBeCloseTo(0.1);
    }
  });

  it('defaults an omitted marks field to null rather than failing', () => {
    const { marks: _omitted, ...withoutMarks } = valid.questions[0]!;
    const result = GeminiQuestionResponseSchema.safeParse({ questions: [withoutMarks] });

    expect(result.success).toBe(true);
    if (result.success) expect(result.data.questions[0]!.marks).toBeNull();
  });

  it('rejects a non-numeric coordinate', () => {
    const result = GeminiQuestionResponseSchema.safeParse({
      questions: [
        {
          ...valid.questions[0],
          rects: [{ rectPageNumber: 1, x: 'left', y: 0.2, width: 0.7, height: 0.05 }],
        },
      ],
    });

    expect(result.success).toBe(false);
  });

  it('rejects a zero or negative page number', () => {
    expect(
      GeminiQuestionResponseSchema.safeParse({
        questions: [{ ...valid.questions[0], pageNumber: 0 }],
      }).success,
    ).toBe(false);
  });

  it('rejects a missing questions array', () => {
    expect(GeminiQuestionResponseSchema.safeParse({}).success).toBe(false);
    expect(GeminiQuestionResponseSchema.safeParse({ questions: 'none' }).success).toBe(false);
  });

  it('does not enforce the 0-1 range here — that is the validator’s job', () => {
    // Shape validation and meaning validation are separate passes; the
    // service rejects out-of-range geometry with a domain-level message.
    const result = GeminiQuestionResponseSchema.safeParse({
      questions: [
        {
          ...valid.questions[0],
          rects: [{ rectPageNumber: 1, x: 1.4, y: 0.2, width: 0.7, height: 0.05 }],
        },
      ],
    });

    expect(result.success).toBe(true);
  });
});

describe('error classification', () => {
  it('treats rate limiting as retryable', () => {
    const error = classifyGeminiError(Object.assign(new Error('quota'), { status: 429 }));
    expect(error).toMatchObject({ code: 'DEPENDENCY_UNAVAILABLE', retryable: true });
  });

  it('treats upstream 5xx as retryable', () => {
    expect(classifyGeminiError(Object.assign(new Error('boom'), { status: 503 }))).toMatchObject({
      retryable: true,
    });
  });

  it('treats a timeout as retryable', () => {
    const abort = Object.assign(new Error('aborted'), { name: 'TimeoutError' });
    expect(classifyGeminiError(abort, 5000)).toMatchObject({ retryable: true });
  });

  it('treats a network failure as retryable', () => {
    expect(classifyGeminiError(new Error('fetch failed: ECONNRESET'))).toMatchObject({
      retryable: true,
    });
  });

  it('treats a rejected API key as permanent', () => {
    const error = classifyGeminiError(Object.assign(new Error('unauthorized'), { status: 401 }));
    expect(error).toMatchObject({ code: 'VALIDATION_ERROR', retryable: false });
  });

  it('treats a rejected request as permanent', () => {
    const error = classifyGeminiError(Object.assign(new Error('bad request'), { status: 400 }));
    expect(error).toMatchObject({ code: 'INVALID_DOCUMENT', retryable: false });
  });

  it('reads a status folded into the message', () => {
    expect(classifyGeminiError(new Error('got 429 Too Many Requests'))).toMatchObject({
      retryable: true,
    });
  });

  it('treats an unknown failure as retryable so a blip is not discarded', () => {
    expect(classifyGeminiError(new Error('something odd'))).toMatchObject({ retryable: true });
  });

  it('never puts a credential in the message', () => {
    const error = classifyGeminiError(
      Object.assign(new Error('key AIzaSyFAKEKEY rejected'), { status: 403 }),
    );

    expect(error.message).not.toContain('AIzaSyFAKEKEY');
  });
});

describe('extraction prompt', () => {
  it('is versioned so a change in output can be traced', () => {
    expect(QUESTION_EXTRACTION_PROMPT_VERSION).toBe('question-extraction/v2');
  });

  it('states the page count and 1-based numbering', () => {
    const prompt = buildQuestionExtractionPrompt(4);

    expect(prompt).toContain('4 page images');
    expect(prompt).toContain('1-based');
  });

  it('uses the singular for a one-page paper', () => {
    expect(buildQuestionExtractionPrompt(1)).toContain('1 page image,');
  });

  it('forbids inventing questions and inferring marks', () => {
    const prompt = buildQuestionExtractionPrompt(2);

    expect(prompt).toMatch(/Do not renumber, tidy, expand or invent labels/);
    expect(prompt).toMatch(/Never infer, split or total marks/);
  });

  it('describes the coordinate convention it expects back', () => {
    const prompt = buildQuestionExtractionPrompt(2);

    expect(prompt).toContain('top-left');
    expect(prompt).toContain('y increases downward');
    expect(prompt).toMatch(/between 0 and 1/);
  });

  it('separates instructions from questions and names sub-parts', () => {
    const prompt = buildQuestionExtractionPrompt(2);

    expect(prompt).toContain('Answer any five questions');
    expect(prompt).toMatch(/"11 \(a\)" and "11 \(b\)" are two entries/);
  });
});
