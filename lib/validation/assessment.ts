import { z } from 'zod';
import { DOCUMENT_TYPES } from '@/lib/domain/document';

export const CreateAssessmentSchema = z.object({
  title: z.string().min(1).max(200).nullable().optional(),
});

export type CreateAssessmentBody = z.infer<typeof CreateAssessmentSchema>;

/**
 * Upload form fields. The file itself is validated by content, not by these
 * declarations — see `lib/services/document/file-validation.ts`.
 */
export const UploadDocumentSchema = z.object({
  type: z.enum(DOCUMENT_TYPES, {
    errorMap: () => ({
      message: `type must be one of ${DOCUMENT_TYPES.join(', ')}.`,
    }),
  }),
});

export type UploadDocumentFields = z.infer<typeof UploadDocumentSchema>;

export const DocumentIdParamSchema = z.object({
  assessmentId: z.string().uuid('assessmentId must be a valid UUID.'),
  documentId: z.string().uuid('documentId must be a valid UUID.'),
});

export const PageParamSchema = DocumentIdParamSchema.extend({
  pageNumber: z.coerce
    .number()
    .int('pageNumber must be an integer.')
    .positive('pageNumber must be 1 or greater.'),
});

/**
 * Review action bodies.
 *
 * A reason is optional everywhere but bounded, so a client cannot use it as
 * an unbounded storage field. `reviewerId` is nullable because this
 * assignment has no authentication — inventing one would be scope no-one
 * asked for, but losing who acted would make the audit trail worth less.
 */
const ReviewerFields = {
  reason: z.string().max(1000, 'A review reason must be 1000 characters or fewer.')
    .nullable()
    .optional(),
  reviewerId: z.string().min(1).max(200).nullable().optional(),
};

export const ReviewActionSchema = z.object(ReviewerFields);

export const RemapActionSchema = z.object({
  ...ReviewerFields,
  questionId: z.string().uuid('questionId must be a valid UUID.'),
});

export const ReviewIdParamSchema = z.object({
  assessmentId: z.string().uuid('assessmentId must be a valid UUID.'),
  reviewId: z.string().uuid('reviewId must be a valid UUID.'),
});

export type ReviewActionBody = z.infer<typeof ReviewActionSchema>;
export type RemapActionBody = z.infer<typeof RemapActionSchema>;

/**
 * A question id in the path is a client-supplied string like any other. It is
 * checked for shape here and for ownership at the route, so a valid UUID from
 * another assessment cannot read a grade that is not part of this one.
 */
export const QuestionIdParamSchema = z.object({
  assessmentId: z.string().uuid('assessmentId must be a valid UUID.'),
  questionId: z.string().uuid('questionId must be a valid UUID.'),
});
