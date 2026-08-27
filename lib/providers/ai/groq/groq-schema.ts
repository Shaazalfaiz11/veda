/**
 * JSON Schemas for Groq's strict structured output.
 *
 * Groq constrains decoding against these, so a response cannot violate the
 * shape — which removes the failure mode that dominated the Gemini work,
 * where a long reply arrived truncated and unparseable.
 *
 * Strict mode has two hard requirements: every property must appear in
 * `required`, and every object must set `additionalProperties: false`. A
 * field that is genuinely optional is therefore expressed as a nullable type
 * rather than an absent one — which is why `marks` and `claimedLabelRaw` are
 * `['integer', 'null']` and `['string', 'null']` here.
 *
 * These mirror the Zod validators in `gemini/*-schema.ts`, which remain the
 * authority on what is accepted. The schema makes the model's output
 * well-shaped; validation still decides whether it is usable.
 */

export type JsonSchema = Record<string, unknown>;

const REGION_PROPERTIES = {
  x: { type: 'number', description: 'Left edge, 0-1 fraction of page width.' },
  y: { type: 'number', description: 'Top edge, 0-1 fraction of page height.' },
  width: { type: 'number', description: 'Width, 0-1 fraction of page width.' },
  height: { type: 'number', description: 'Height, 0-1 fraction of page height.' },
} as const;

/** Question extraction — mirrors `GeminiQuestionResponseSchema`. */
export const GROQ_QUESTION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['questions'],
  properties: {
    questions: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['labelRaw', 'text', 'marks', 'pageNumber', 'rects'],
        properties: {
          labelRaw: {
            type: 'string',
            description: 'The label exactly as printed, e.g. "11 (a)". Empty string if unlabelled.',
          },
          text: { type: 'string', description: 'The question wording, copied faithfully.' },
          marks: {
            type: ['integer', 'null'],
            description: 'Marks printed for this question, or null if none is shown.',
          },
          pageNumber: {
            type: 'integer',
            description: '1-based page the question starts on.',
          },
          rects: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['rectPageNumber', 'x', 'y', 'width', 'height'],
              properties: {
                rectPageNumber: {
                  type: 'integer',
                  description: '1-based page this region lies on.',
                },
                ...REGION_PROPERTIES,
              },
            },
          },
        },
      },
    },
  },
};

/** Answer extraction — mirrors `GeminiAnswerResponseSchema`. */
export const GROQ_ANSWER_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['answers'],
  properties: {
    answers: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['claimedLabelRaw', 'text', 'regions'],
        properties: {
          claimedLabelRaw: {
            type: ['string', 'null'],
            description:
              'The label the student wrote, verbatim, or null when they wrote none.',
          },
          text: { type: 'string', description: 'Faithful transcription of the handwriting.' },
          regions: {
            type: 'array',
            items: {
              type: 'object',
              additionalProperties: false,
              required: ['pageNumber', 'x', 'y', 'width', 'height', 'kind'],
              properties: {
                pageNumber: {
                  type: 'integer',
                  description: '1-based page this region lies on.',
                },
                ...REGION_PROPERTIES,
                kind: {
                  type: 'string',
                  enum: ['text', 'diagram'],
                  description: '"diagram" for a drawing, "text" for written work.',
                },
              },
            },
          },
        },
      },
    },
  },
};

/** Mapping adjudication — mirrors `GeminiAdjudicationSchema`. */
export const GROQ_ADJUDICATION_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['decision', 'questionId', 'reasonCode', 'confidence'],
  properties: {
    decision: {
      type: 'string',
      enum: ['MATCH', 'NO_MATCH'],
      description: 'MATCH when one candidate addresses the answer, otherwise NO_MATCH.',
    },
    questionId: {
      type: ['string', 'null'],
      description: 'One of the supplied candidate ids, or null for NO_MATCH.',
    },
    reasonCode: { type: 'string', description: 'Why this decision was reached.' },
    confidence: { type: 'number', description: 'How sure you are, from 0 to 1.' },
  },
};

/** Grading — mirrors `GeminiGradingSchema`. */
export const GROQ_GRADING_SCHEMA: JsonSchema = {
  type: 'object',
  additionalProperties: false,
  required: ['criteria', 'totalAwardedMarks', 'confidence', 'feedback'],
  properties: {
    criteria: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        required: ['criterionId', 'awardedMarks', 'reason'],
        properties: {
          criterionId: {
            type: 'string',
            description: 'One of the criterion ids supplied, exactly as given.',
          },
          awardedMarks: {
            type: 'number',
            description: 'Marks for this criterion, within its maximum.',
          },
          reason: { type: 'string', description: 'Why those marks, in one or two sentences.' },
        },
      },
    },
    totalAwardedMarks: {
      type: 'number',
      description: 'The sum of the criterion marks. Must add up exactly.',
    },
    confidence: { type: 'number', description: 'How sure you are of this marking, 0 to 1.' },
    feedback: { type: 'string', description: 'Two or three sentences addressed to the student.' },
  },
};
