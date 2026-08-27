import { Type, type Schema } from '@google/genai';
import { z } from 'zod';
import { ANSWER_REGION_KINDS } from '@/lib/domain/answer';

/**
 * The wire contract for answer extraction.
 *
 * As with questions, two representations: one handed to Gemini so it emits
 * structured data, one applied to whatever actually comes back. The second is
 * not redundant — a response schema constrains shape, not meaning, and cannot
 * stop a coordinate of 1.4, a page number of 99, or an empty transcription.
 *
 * Note what the schema does *not* contain: any field naming a question. The
 * model is given no place to record a mapping decision, which is the most
 * reliable way to stop it making one.
 */

const REGION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    pageNumber: {
      type: Type.INTEGER,
      description: '1-based page this region lies on.',
    },
    x: { type: Type.NUMBER, description: 'Left edge, 0-1 fraction of page width.' },
    y: { type: Type.NUMBER, description: 'Top edge, 0-1 fraction of page height.' },
    width: { type: Type.NUMBER, description: 'Width, 0-1 fraction of page width.' },
    height: { type: Type.NUMBER, description: 'Height, 0-1 fraction of page height.' },
    kind: {
      type: Type.STRING,
      enum: [...ANSWER_REGION_KINDS],
      description: '"diagram" for a drawing, "text" for written work.',
    },
  },
  required: ['pageNumber', 'x', 'y', 'width', 'height', 'kind'],
  propertyOrdering: ['pageNumber', 'x', 'y', 'width', 'height', 'kind'],
};

const ANSWER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    claimedLabelRaw: {
      type: Type.STRING,
      nullable: true,
      description:
        'The question label the student wrote, exactly as written. Null if they wrote none.',
    },
    text: {
      type: Type.STRING,
      description: 'Faithful transcription. Use "[unclear]" for illegible stretches.',
    },
    regions: {
      type: Type.ARRAY,
      items: REGION_SCHEMA,
      description: 'One or more regions locating the answer.',
    },
  },
  required: ['claimedLabelRaw', 'text', 'regions'],
  propertyOrdering: ['claimedLabelRaw', 'text', 'regions'],
};

export const GEMINI_ANSWER_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    answers: {
      type: Type.ARRAY,
      items: ANSWER_SCHEMA,
      description: 'Every distinct block of student work, in the order it appears.',
    },
  },
  required: ['answers'],
  propertyOrdering: ['answers'],
};

/** Tolerates a stringified number, which models sometimes emit. */
const NumericString = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a finite number' });
    return z.NEVER;
  }

  return parsed;
});

export const GeminiAnswerRegionSchema = z.object({
  pageNumber: NumericString.pipe(
    z.number().int('pageNumber must be an integer').positive('pageNumber must be 1-based'),
  ),
  x: NumericString,
  y: NumericString,
  width: NumericString,
  height: NumericString,
  // An unrecognised kind falls back to text rather than failing the answer:
  // the geometry is the valuable part, and mislabelling a diagram as text
  // costs far less than discarding a located answer.
  kind: z
    .enum(ANSWER_REGION_KINDS)
    .catch('text')
    .default('text'),
});

export const GeminiAnswerSchema = z.object({
  // An absent field and an explicit null both mean "no label written".
  claimedLabelRaw: z.string().nullable().optional().default(null),
  text: z.string(),
  regions: z.array(GeminiAnswerRegionSchema),
});

export const GeminiAnswerResponseSchema = z.object({
  answers: z.array(GeminiAnswerSchema),
});

export type GeminiAnswerResponse = z.infer<typeof GeminiAnswerResponseSchema>;
export type GeminiAnswer = z.infer<typeof GeminiAnswerSchema>;
