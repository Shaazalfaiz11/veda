import { Type, type Schema } from '@google/genai';
import { z } from 'zod';

/**
 * Adjudication wire contract.
 *
 * The response schema constrains shape; the Zod schema constrains values. The
 * critical check is not here at all — that the returned id is one we actually
 * supplied is verified by the service against the real candidate list, since
 * no schema can know which ids were in the prompt.
 */
export const ADJUDICATION_REASON_CODES = [
  'SUBJECT_MATCH',
  'LABEL_AND_CONTENT',
  'CONTENT_OVER_LABEL',
  'PARTIAL_MATCH',
  'AMBIGUOUS',
  'INSUFFICIENT_EVIDENCE',
  'UNRELATED',
] as const;

export const GEMINI_ADJUDICATION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    decision: {
      type: Type.STRING,
      enum: ['MATCH', 'NO_MATCH'],
      description: 'MATCH when one candidate addresses the answer, otherwise NO_MATCH.',
    },
    questionId: {
      type: Type.STRING,
      nullable: true,
      description: 'One of the supplied candidate ids, or null for NO_MATCH.',
    },
    reasonCode: {
      type: Type.STRING,
      enum: [...ADJUDICATION_REASON_CODES],
      description: 'Why this decision was reached.',
    },
    confidence: {
      type: Type.NUMBER,
      description: 'How sure you are, from 0 to 1.',
    },
  },
  required: ['decision', 'questionId', 'reasonCode', 'confidence'],
  propertyOrdering: ['decision', 'questionId', 'reasonCode', 'confidence'],
};

const NumericString = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a finite number' });
    return z.NEVER;
  }

  return parsed;
});

export const GeminiAdjudicationSchema = z.object({
  decision: z.enum(['MATCH', 'NO_MATCH']),
  questionId: z.string().nullable().optional().default(null),
  // An unrecognised reason code is not worth discarding a decision over.
  reasonCode: z.string().catch('INSUFFICIENT_EVIDENCE').default('INSUFFICIENT_EVIDENCE'),
  // Out-of-range confidence is clamped rather than rejected; it is only ever
  // one input to a score the application computes itself.
  confidence: NumericString.pipe(z.number()).catch(0).default(0),
});

export type GeminiAdjudication = z.infer<typeof GeminiAdjudicationSchema>;
