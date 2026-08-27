import { Type, type Schema } from '@google/genai';
import { z } from 'zod';

/**
 * The wire contract for question extraction.
 *
 * Two representations of the same shape, and both are needed:
 *
 *   GEMINI_QUESTION_SCHEMA  handed to the model as a response schema, so it
 *                           emits structured data rather than prose.
 *   GeminiQuestionResponse  a Zod schema applied to whatever actually comes
 *                           back.
 *
 * The second is not redundant. A response schema constrains shape, not
 * meaning: it cannot stop a coordinate being 1.4, a page number being 99, or
 * a question text being empty. The model is a source of candidates, never of
 * truth, so its output is parsed exactly as strictly as an HTTP body would
 * be.
 *
 * `propertyOrdering` is set because Gemini honours it when serialising, and a
 * stable field order makes responses easier to read in logs and diffs.
 */

const RECT_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    rectPageNumber: {
      type: Type.INTEGER,
      description: '1-based page this region lies on.',
    },
    x: { type: Type.NUMBER, description: 'Left edge, 0-1 fraction of page width.' },
    y: { type: Type.NUMBER, description: 'Top edge, 0-1 fraction of page height.' },
    width: { type: Type.NUMBER, description: 'Width, 0-1 fraction of page width.' },
    height: { type: Type.NUMBER, description: 'Height, 0-1 fraction of page height.' },
  },
  required: ['rectPageNumber', 'x', 'y', 'width', 'height'],
  propertyOrdering: ['rectPageNumber', 'x', 'y', 'width', 'height'],
};

const QUESTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    labelRaw: {
      type: Type.STRING,
      description: 'The label exactly as printed, e.g. "11 (a)". Empty string if unlabelled.',
    },
    text: {
      type: Type.STRING,
      description: 'The question wording, copied faithfully.',
    },
    marks: {
      type: Type.INTEGER,
      nullable: true,
      description: 'Printed mark allocation, or null when none is visible. Never inferred.',
    },
    pageNumber: {
      type: Type.INTEGER,
      description: '1-based page the question starts on.',
    },
    rects: {
      type: Type.ARRAY,
      items: RECT_SCHEMA,
      description: 'One or more regions bounding the question.',
    },
  },
  required: ['labelRaw', 'text', 'marks', 'pageNumber', 'rects'],
  propertyOrdering: ['labelRaw', 'text', 'marks', 'pageNumber', 'rects'],
};

export const GEMINI_QUESTION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    questions: {
      type: Type.ARRAY,
      items: QUESTION_SCHEMA,
      description: 'Every question found, in printed order.',
    },
  },
  required: ['questions'],
  propertyOrdering: ['questions'],
};

/**
 * Post-hoc validation.
 *
 * Kept permissive about *shape* — coercing a stringified number, tolerating a
 * missing marks field — but strict about *values*, which is where the
 * downstream damage lives. `.strip()` is the default, so any field the model
 * invents is discarded rather than reaching the domain.
 */
const NumericString = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a finite number' });
    return z.NEVER;
  }

  return parsed;
});

export const GeminiRectSchema = z.object({
  rectPageNumber: NumericString.pipe(
    z.number().int('rectPageNumber must be an integer').positive('rectPageNumber must be 1-based'),
  ),
  x: NumericString,
  y: NumericString,
  width: NumericString,
  height: NumericString,
});

export const GeminiQuestionSchema = z.object({
  labelRaw: z.string(),
  text: z.string(),
  marks: NumericString.pipe(z.number()).nullable().optional().default(null),
  pageNumber: NumericString.pipe(
    z.number().int('pageNumber must be an integer').positive('pageNumber must be 1-based'),
  ),
  rects: z.array(GeminiRectSchema),
});

export const GeminiQuestionResponseSchema = z.object({
  questions: z.array(GeminiQuestionSchema),
});

export type GeminiQuestionResponse = z.infer<typeof GeminiQuestionResponseSchema>;
export type GeminiQuestion = z.infer<typeof GeminiQuestionSchema>;
