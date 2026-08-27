import { ConflictError } from '@/lib/errors';
import type { ReviewStatus, ReviewerAction } from './types';

/**
 * Review lifecycle.
 *
 *     PENDING ──► IN_REVIEW ──► RESOLVED
 *        │            │
 *        └────────────┴──────► SKIPPED ──► IN_REVIEW ──► RESOLVED
 *
 * RESOLVED is terminal. A teacher changing their mind is a real workflow, but
 * it is a *different* workflow — reopening a settled decision silently would
 * make the audit trail describe something that did not happen. If that
 * becomes a requirement it gets its own explicit transition rather than being
 * smuggled in through an ordinary action.
 *
 * SKIPPED is not terminal: deferring an item is precisely a statement that it
 * will be looked at again.
 */
const ALLOWED_TRANSITIONS: Record<ReviewStatus, readonly ReviewStatus[]> = {
  PENDING: ['IN_REVIEW', 'RESOLVED', 'SKIPPED'],
  IN_REVIEW: ['RESOLVED', 'SKIPPED'],
  SKIPPED: ['IN_REVIEW', 'RESOLVED'],
  RESOLVED: [],
};

export function canTransitionReview(from: ReviewStatus, to: ReviewStatus): boolean {
  return ALLOWED_TRANSITIONS[from].includes(to);
}

export function assertReviewTransition(from: ReviewStatus, to: ReviewStatus): void {
  if (!canTransitionReview(from, to)) {
    throw new ConflictError(`Cannot transition review from ${from} to ${to}.`, {
      from,
      to,
      allowed: ALLOWED_TRANSITIONS[from],
    });
  }
}

export function allowedReviewTransitionsFrom(status: ReviewStatus): readonly ReviewStatus[] {
  return ALLOWED_TRANSITIONS[status];
}

/** RESOLVED is the only settled state; SKIPPED explicitly expects a revisit. */
export function isReviewSettled(status: ReviewStatus): boolean {
  return status === 'RESOLVED';
}

/** The status an action moves a review into. */
export function statusForAction(action: ReviewerAction): ReviewStatus {
  return action === 'SKIP' ? 'SKIPPED' : 'RESOLVED';
}
