import { randomUUID } from 'node:crypto';
import { ConflictError, NotFoundError, ValidationError } from '@/lib/errors';
import { logger } from '@/lib/logger';
import type { Assessment } from '@/lib/domain/assessment';
import type { AnswerMapping } from '@/lib/domain/mapping';
import {
  assertReviewTransition,
  findAnswerHoldingQuestion,
  isReviewSettled,
  resolveEffectiveMapping,
  statusForAction,
  type EffectiveMapping,
  type MappingReview,
  type ReviewAuditEvent,
  type ReviewSummary,
  type ReviewerAction,
} from '@/lib/domain/review';
import { getAssessmentStore } from '@/lib/services/assessment-store';

/**
 * Human review.
 *
 * Every action here adds a decision layer; none of them edit an AI mapping.
 * The AI's conclusion, its confidence, its candidates and the adjudicator's
 * verdict are historical facts about what a model decided at a point in time,
 * and a teacher disagreeing does not make them untrue.
 *
 * All state lives on the assessment record and every write goes through the
 * Phase 1 optimistic update, so two reviewers acting at once cannot lose each
 * other's decisions.
 */

export interface ReviewActionInput {
  assessmentId: string;
  reviewId: string;
  /** Null where the assignment has no authentication. */
  reviewerId?: string | null;
  reason?: string | null;
}

export interface RemapInput extends ReviewActionInput {
  questionId: string;
}

export interface ReviewActionOutcome {
  review: MappingReview;
  effective: EffectiveMapping;
  /** False when the action was a no-op repeat of one already recorded. */
  changed: boolean;
}

/** Longest reason text accepted. Enough for a sentence, not for a payload. */
export const MAX_REASON_LENGTH = 1000;

function now(): string {
  return new Date().toISOString();
}

export async function listReviews(assessmentId: string): Promise<MappingReview[]> {
  const assessment = await getAssessmentStore().get(assessmentId);
  return assessment.reviews;
}

export async function getReview(
  assessmentId: string,
  reviewId: string,
): Promise<MappingReview> {
  const assessment = await getAssessmentStore().get(assessmentId);
  return findReview(assessment, reviewId);
}

export async function listAuditEvents(assessmentId: string): Promise<ReviewAuditEvent[]> {
  const assessment = await getAssessmentStore().get(assessmentId);
  return assessment.reviewAudit;
}

/** Teacher confirms the AI got it right. */
export async function acceptReview(input: ReviewActionInput): Promise<ReviewActionOutcome> {
  return applyAction(input, 'ACCEPT', null);
}

/** Teacher picks a different question. */
export async function remapReview(input: RemapInput): Promise<ReviewActionOutcome> {
  return applyAction(input, 'REMAP', input.questionId);
}

/** Teacher decides the answer belongs to no question on the paper. */
export async function rejectReview(input: ReviewActionInput): Promise<ReviewActionOutcome> {
  return applyAction(input, 'REJECT', null);
}

/** Teacher defers. Explicitly not a decision either way. */
export async function skipReview(input: ReviewActionInput): Promise<ReviewActionOutcome> {
  return applyAction(input, 'SKIP', null);
}

/**
 * The one path every action takes.
 *
 * Validation, conflict detection, idempotency, state transition and audit all
 * happen here so no action can quietly skip one of them.
 */
async function applyAction(
  input: ReviewActionInput,
  action: ReviewerAction,
  questionId: string | null,
): Promise<ReviewActionOutcome> {
  const reason = normaliseReason(input.reason);
  const reviewerId = input.reviewerId ?? null;

  let outcome: ReviewActionOutcome | null = null;
  let auditEvent: ReviewAuditEvent | null = null;

  await getAssessmentStore().update(input.assessmentId, (assessment) => {
    const review = findReview(assessment, input.reviewId);
    const mapping = findMapping(assessment, review.answerId);

    // A repeat of the decision already recorded is a no-op, not a conflict.
    // A double-clicked ACCEPT must not produce two audit events, and must not
    // be mistaken for a teacher changing their mind.
    if (isRepeat(review, action, questionId)) {
      outcome = {
        review,
        effective: resolveEffectiveMapping(mapping, review),
        changed: false,
      };
      return assessment;
    }

    if (isReviewSettled(review.status)) {
      throw new ConflictError(
        'This review has already been resolved and cannot be changed.',
        {
          reviewId: review.id,
          status: review.status,
          recordedAction: review.decision?.action ?? null,
        },
      );
    }

    if (action === 'REMAP') {
      assertRemapTarget(assessment, review, questionId);
    }

    const nextStatus = statusForAction(action);
    assertReviewTransition(review.status, nextStatus);

    const updated: MappingReview = {
      ...review,
      status: nextStatus,
      decision: {
        action,
        questionId: action === 'REMAP' ? questionId : null,
        reason,
        reviewerId,
        decidedAt: now(),
      },
      updatedAt: now(),
    };

    const effective = resolveEffectiveMapping(mapping, updated);

    auditEvent = {
      id: randomUUID(),
      reviewId: updated.id,
      assessmentId: assessment.id,
      answerId: updated.answerId,
      action,
      originalQuestionId: updated.original.questionId,
      finalQuestionId: effective.questionId,
      reviewerId,
      reason,
      occurredAt: now(),
    };

    outcome = { review: updated, effective, changed: true };

    return {
      ...assessment,
      // The AI mappings array is copied through untouched.
      reviews: assessment.reviews.map((entry) =>
        entry.id === updated.id ? updated : entry,
      ),
      reviewAudit: [...assessment.reviewAudit, auditEvent],
      updatedAt: now(),
    };
  });

  if (!outcome) {
    throw new NotFoundError(`Review ${input.reviewId} was not found.`);
  }

  const result = outcome as ReviewActionOutcome;

  if (result.changed) {
    logger.info(
      {
        assessmentId: input.assessmentId,
        answerId: result.review.answerId,
        reviewId: result.review.id,
        action,
        originalQuestionId: result.review.original.questionId,
        finalQuestionId: result.effective.questionId,
        reviewerId,
        status: result.review.status,
      },
      auditEventName(action),
    );
  }

  return result;
}

/**
 * Whether this action simply repeats what is already recorded.
 *
 * Compared on action *and* target: repeating ACCEPT is the same decision, but
 * a REMAP to a different question is a new one and must not be swallowed.
 */
function isRepeat(
  review: MappingReview,
  action: ReviewerAction,
  questionId: string | null,
): boolean {
  const decision = review.decision;
  if (!decision || decision.action !== action) return false;

  if (action === 'REMAP') return decision.questionId === questionId;
  return true;
}

/**
 * Checks a remap target belongs to this assessment and is free.
 *
 * Taking a question already held by another answer is refused rather than
 * resolved automatically: silently unmapping someone else's answer to satisfy
 * this one would be a destructive edit the teacher never asked for, and they
 * are the only one who can say which of the two is right.
 */
function assertRemapTarget(
  assessment: Assessment,
  review: MappingReview,
  questionId: string | null,
): void {
  if (!questionId) {
    throw new ValidationError('REMAP requires a questionId.');
  }

  const question = assessment.questions.find((entry) => entry.id === questionId);

  if (!question) {
    throw new NotFoundError(
      `Question ${questionId} does not belong to assessment ${assessment.id}.`,
      { questionId, assessmentId: assessment.id },
    );
  }

  const holder = findAnswerHoldingQuestion(
    questionId,
    assessment.mappings,
    assessment.reviews,
    review.answerId,
  );

  if (holder) {
    throw new ConflictError(`Question ${questionId} is already assigned to another answer.`, {
      code: 'QUESTION_ALREADY_ASSIGNED',
      questionId,
      existingAnswerId: holder,
    });
  }
}

function findReview(assessment: Assessment, reviewId: string): MappingReview {
  const review = assessment.reviews.find((entry) => entry.id === reviewId);

  // Not-found rather than forbidden: a review id belonging to a different
  // assessment must not be distinguishable from one that never existed.
  if (!review) {
    throw new NotFoundError(
      `Review ${reviewId} was not found on assessment ${assessment.id}.`,
    );
  }

  return review;
}

function findMapping(assessment: Assessment, answerId: string): AnswerMapping {
  const mapping = assessment.mappings.find((entry) => entry.answerId === answerId);

  if (!mapping) {
    throw new NotFoundError(`No mapping exists for answer ${answerId}.`);
  }

  return mapping;
}

function normaliseReason(reason: string | null | undefined): string | null {
  if (reason === null || reason === undefined) return null;

  const trimmed = reason.trim();
  if (trimmed.length === 0) return null;

  if (trimmed.length > MAX_REASON_LENGTH) {
    throw new ValidationError(
      `A review reason must be ${MAX_REASON_LENGTH} characters or fewer.`,
      { maxLength: MAX_REASON_LENGTH, length: trimmed.length },
    );
  }

  return trimmed;
}

function auditEventName(action: ReviewerAction): string {
  switch (action) {
    case 'ACCEPT':
      return 'mapping.review.accepted';
    case 'REMAP':
      return 'mapping.review.remapped';
    case 'REJECT':
      return 'mapping.review.rejected';
    case 'SKIP':
      return 'mapping.review.skipped';
  }
}

/**
 * Derived entirely from the canonical mapping and review records — nothing
 * here is stored, so it cannot fall out of step with what it describes.
 */
export function summariseReviews(assessment: Assessment): ReviewSummary {
  const { mappings, reviews, answers } = assessment;

  const effective = mappings.map((mapping) =>
    resolveEffectiveMapping(
      mapping,
      reviews.find((review) => review.answerId === mapping.answerId) ?? null,
    ),
  );

  return {
    totalAnswers: answers.length,

    autoMapped: mappings.filter((m) => m.status === 'AUTO_MAPPED').length,
    reviewRequired: mappings.filter((m) => m.status === 'REVIEW_REQUIRED').length,
    humanReview: mappings.filter((m) => m.status === 'HUMAN_REVIEW').length,
    unmapped: mappings.filter((m) => m.status === 'UNMAPPED').length,

    totalReviews: reviews.length,
    pending: reviews.filter((r) => r.status === 'PENDING').length,
    inReview: reviews.filter((r) => r.status === 'IN_REVIEW').length,
    resolved: reviews.filter((r) => r.status === 'RESOLVED').length,
    skipped: reviews.filter((r) => r.status === 'SKIPPED').length,

    effectivelyMapped: effective.filter((e) => e.questionId !== null).length,
    effectivelyUnmapped: effective.filter((e) => e.questionId === null).length,
    humanOverridden: effective.filter((e) => e.source === 'HUMAN').length,
  };
}

export async function getReviewSummary(assessmentId: string): Promise<ReviewSummary> {
  return summariseReviews(await getAssessmentStore().get(assessmentId));
}
