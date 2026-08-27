import type {
  AdjudicationRecord,
  ConfidenceBand,
  MappingCandidate,
  MappingReasonCode,
  MappingSignals,
  MappingStatus,
} from '@/lib/domain/mapping';

/**
 * Human review domain.
 *
 * The AI's decision is evidence, not a verdict. This layer lets a teacher
 * correct a mapping without destroying what the AI concluded — the two
 * coexist, and the "effective" mapping is derived from both:
 *
 *     AnswerMapping (AI, immutable)
 *              │
 *              ▼
 *       MappingReview (human decision layer)
 *              │
 *              ▼
 *       effective mapping
 *
 * Nothing here overwrites a mapping. A review snapshots the AI decision it
 * responded to at the moment it was created, so the record stays meaningful
 * even if mapping is later re-run.
 */

/**
 * Where a review item sits in its own workflow. Deliberately separate from
 * MappingStatus: a mapping can be REVIEW_REQUIRED while its review is still
 * PENDING, and RESOLVED while the AI mapping still says REVIEW_REQUIRED.
 */
export const REVIEW_STATUSES = ['PENDING', 'IN_REVIEW', 'RESOLVED', 'SKIPPED'] as const;
export type ReviewStatus = (typeof REVIEW_STATUSES)[number];

/**
 * What the teacher did. Separate enum from status on purpose — "SKIPPED" is a
 * state the item is in, "SKIP" is a thing a person did, and collapsing them
 * would lose the distinction between "nobody has looked" and "someone looked
 * and deferred".
 */
export const REVIEWER_ACTIONS = ['ACCEPT', 'REMAP', 'REJECT', 'SKIP'] as const;
export type ReviewerAction = (typeof REVIEWER_ACTIONS)[number];

/** Why this item was put in front of a human. */
export const REVIEW_TRIGGERS = [
  'MEDIUM_CONFIDENCE',
  'LOW_CONFIDENCE',
  'UNMAPPED',
  'AI_NO_MATCH',
  'CONFLICT_RESOLVED',
  'NO_CANDIDATES',
] as const;
export type ReviewTrigger = (typeof REVIEW_TRIGGERS)[number];

/**
 * An immutable snapshot of the AI decision this review responded to.
 *
 * Copied rather than referenced so the historical record cannot be altered
 * by anything that happens to the mapping afterwards — including a full
 * re-run of the MAPPING stage.
 */
export interface OriginalAIDecision {
  mappingId: string;
  questionId: string | null;
  status: MappingStatus;
  confidence: number;
  confidenceBand: ConfidenceBand;
  signals: MappingSignals | null;
  reasonCodes: MappingReasonCode[];
  candidates: MappingCandidate[];
  adjudication: AdjudicationRecord | null;
  mappedAt: string;
}

/** What the teacher decided, once they decided anything. */
export interface ReviewerDecision {
  action: ReviewerAction;
  /** The question the teacher chose. Null for REJECT. */
  questionId: string | null;
  reason: string | null;
  /** Null where the assignment has no authentication. */
  reviewerId: string | null;
  decidedAt: string;
}

export interface MappingReview {
  id: string;
  assessmentId: string;
  answerId: string;

  status: ReviewStatus;
  trigger: ReviewTrigger;

  /** Never mutated after creation. */
  original: OriginalAIDecision;

  /** Null until a teacher acts. */
  decision: ReviewerDecision | null;

  createdAt: string;
  updatedAt: string;
}

/** Where the effective mapping came from. */
export const MAPPING_SOURCES = ['AI', 'HUMAN'] as const;
export type MappingSource = (typeof MAPPING_SOURCES)[number];

/**
 * The mapping the rest of the system should act on: the human decision when
 * one exists, the AI's otherwise. Derived, never stored — a stored copy would
 * be one more thing that can drift out of step with the two records it
 * summarises.
 */
export interface EffectiveMapping {
  answerId: string;
  questionId: string | null;
  source: MappingSource;
  /** Confidence of the AI decision. A human decision carries no score. */
  confidence: number | null;
  confidenceBand: ConfidenceBand | null;
}

/**
 * One recorded human action.
 *
 * Append-only. Actions are events, not state: a review that was skipped and
 * later accepted has two entries, and neither replaces the other.
 */
export interface ReviewAuditEvent {
  id: string;
  reviewId: string;
  assessmentId: string;
  answerId: string;
  action: ReviewerAction;
  /** The AI's question at the time of the action. */
  originalQuestionId: string | null;
  /** The question in force after the action. Null when rejected. */
  finalQuestionId: string | null;
  reviewerId: string | null;
  reason: string | null;
  occurredAt: string;
}

export interface ReviewSummary {
  totalAnswers: number;

  /** From the AI mapping statuses. */
  autoMapped: number;
  reviewRequired: number;
  humanReview: number;
  unmapped: number;

  /** From the review queue. */
  totalReviews: number;
  pending: number;
  inReview: number;
  resolved: number;
  skipped: number;

  /** From the effective mappings. */
  effectivelyMapped: number;
  effectivelyUnmapped: number;
  humanOverridden: number;
}

export function isReviewStatus(value: unknown): value is ReviewStatus {
  return typeof value === 'string' && (REVIEW_STATUSES as readonly string[]).includes(value);
}

export function isReviewerAction(value: unknown): value is ReviewerAction {
  return typeof value === 'string' && (REVIEWER_ACTIONS as readonly string[]).includes(value);
}
