import { Type, type Schema } from '@google/genai';
import { z } from 'zod';

/**
 * Grading wire contract.
 *
 * As elsewhere, the response schema constrains shape and the Zod schema
 * constrains values — but neither can do the check that matters most. That a
 * criterion id was actually on the rubric, that its marks are within its
 * ceiling, and that the criteria add up to the reported total are all
 * verified by the service against the real mark scheme, because no schema
 * knows what was in the prompt.
 */
const CRITERION_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    criterionId: {
      type: Type.STRING,
      description: 'One of the criterion ids supplied, exactly as given.',
    },
    awardedMarks: {
      type: Type.NUMBER,
      description: 'Marks for this criterion, within its maximum.',
    },
    reason: {
      type: Type.STRING,
      description: 'Why these marks, referring to what the student wrote.',
    },
  },
  required: ['criterionId', 'awardedMarks', 'reason'],
  propertyOrdering: ['criterionId', 'awardedMarks', 'reason'],
};

export const GEMINI_GRADING_SCHEMA: Schema = {
  type: Type.OBJECT,
  properties: {
    criteria: {
      type: Type.ARRAY,
      items: CRITERION_SCHEMA,
      description: 'One entry per criterion in the mark scheme.',
    },
    totalAwardedMarks: {
      type: Type.NUMBER,
      description: 'Sum of the criterion marks. Must add up exactly.',
    },
    confidence: {
      type: Type.NUMBER,
      description: 'How sure you are of this marking, 0 to 1.',
    },
    feedback: {
      type: Type.STRING,
      description: 'Two or three sentences addressed to the student.',
    },
  },
  required: ['criteria', 'totalAwardedMarks', 'confidence', 'feedback'],
  propertyOrdering: ['criteria', 'totalAwardedMarks', 'confidence', 'feedback'],
};

const NumericString = z.union([z.number(), z.string()]).transform((value, ctx) => {
  const parsed = typeof value === 'number' ? value : Number(value);

  if (!Number.isFinite(parsed)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: 'must be a finite number' });
    return z.NEVER;
  }

  return parsed;
});

export const GeminiCriterionGradeSchema = z.object({
  criterionId: z.string().min(1),
  // Negative marks are rejected here rather than clamped: a grader producing
  // one has misunderstood the task, and the rest of its output is suspect.
  awardedMarks: NumericString.pipe(z.number().min(0, 'awardedMarks cannot be negative')),
  reason: z.string(),
});

export const GeminiGradingSchema = z.object({
  criteria: z.array(GeminiCriterionGradeSchema).min(1, 'at least one criterion is required'),
  totalAwardedMarks: NumericString.pipe(z.number().min(0)),
  // Out-of-range confidence is clamped, not rejected: it is only one input to
  // a score the application computes for itself.
  confidence: NumericString.pipe(z.number()).catch(0).default(0),
  feedback: z.string(),
});

export type GeminiGrading = z.infer<typeof GeminiGradingSchema>;
