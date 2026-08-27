import { z } from 'zod';

/**
 * Route params arrive as strings from the URL and are never trusted. An id
 * that is not a UUID is rejected before it reaches the store, so a malformed
 * path cannot turn into a Redis lookup.
 */
export const AssessmentIdParamSchema = z.object({
  assessmentId: z.string().uuid('assessmentId must be a valid UUID.'),
});

export type AssessmentIdParam = z.infer<typeof AssessmentIdParamSchema>;

/**
 * Parses a request body, treating an absent or malformed body as an empty
 * object so the schema — not the JSON parser — produces the error message.
 */
export async function parseJsonBody(request: Request): Promise<unknown> {
  try {
    const text = await request.text();
    if (!text.trim()) return {};
    return JSON.parse(text);
  } catch {
    return Symbol.for('veda.invalid-json');
  }
}

export const INVALID_JSON = Symbol.for('veda.invalid-json');
