'use client';

import type { GradeItem, Question } from '@/lib/api-client/types';
import { Chevron } from '@/components/ui/Icon';
import { ScoreBadge } from './ScoreBadge';
import styles from './QuestionCard.module.css';

/**
 * One question in the left pane (Figma `1:8901` collapsed, `1:8879`
 * expanded).
 *
 * The card shows the question, what it scored and — when open — the
 * feedback the grading stage wrote. All of it comes from the API; nothing
 * here recomputes a mark or decides an outcome.
 */

export interface QuestionCardProps {
  question: Question;
  /** The grade in force for this question, or null if nothing reached it. */
  grade: GradeItem | null;
  /** Whether the mapping gave this question an answer. */
  hasAnswer: boolean;
  /** The number the paper prints for this question, already resolved. */
  displayNumber: string;
  expanded: boolean;
  onToggle: () => void;
}

export function QuestionCard({
  question,
  grade,
  hasAnswer,
  displayNumber,
  expanded,
  onToggle,
}: QuestionCardProps) {
  // The design numbers a sub-question by its parent and shows the part letter
  // beneath, so 11 a and 11 b sit under one number.
  const part = question.isSubQuestion
    ? question.normalizedLabel.split('-').pop()
    : null;

  const hasFeedback = Boolean(grade?.feedback);

  /*
   * Selecting a question is what drives the highlight in the viewer, so it
   * has to be available whenever the question has an answer to point at.
   * Gating it on feedback tied the whole interaction to grading, which is
   * optional and routinely absent — every card then sat disabled and no
   * answer could ever be highlighted.
   */
  const selectable = hasAnswer || hasFeedback;

  /*
   * Correctness in words, beside the marks.
   *
   * Derived from the marks the grading service already computed rather than
   * asked of the model separately, so the label and the number can never
   * disagree. A grade with no marks says why instead: an answer nothing could
   * be marked against, and one whose marking failed, are different situations
   * and neither of them is a zero.
   */
  const verdict = correctnessOf(grade);

  return (
    <div className={`${styles.card} ${expanded ? styles.cardExpanded : ''}`}>
      {/* The chevron below is the keyboard control; this only adds the larger
          click target a teacher expects from the whole row. */}
      <div
        className={`${styles.row} ${selectable ? styles.rowSelectable : ''}`}
        onClick={selectable ? onToggle : undefined}
      >
        <span className={`${styles.badge} ${expanded ? styles.badgeActive : ''}`}>
          <span>{displayNumber}</span>
          {part ? <span className={styles.badgePart}>{part}</span> : null}
        </span>

        <span className={styles.text}>
          {question.text}
          {hasAnswer ? null : (
            <span className={styles.meta}>
              <span className={styles.tag}>No answer mapped</span>
            </span>
          )}
          {verdict ? (
            <span className={styles.meta}>
              <span className={`${styles.tag} ${verdict.tone ? styles[verdict.tone] : ''}`}>
                {verdict.label}
              </span>
            </span>
          ) : null}
          {grade?.mappingSource === 'HUMAN' ? (
            <span className={styles.meta}>
              <span className={`${styles.tag} ${styles.tagHuman}`}>Teacher corrected</span>
            </span>
          ) : null}
        </span>

        <span className={styles.trailing}>
          <ScoreBadge
            awarded={grade?.awardedMarks ?? null}
            maximum={grade?.maximumMarks ?? question.marks}
          />
          <button
            type="button"
            className={styles.toggle}
            onClick={(event) => {
              // The row is clickable too; without this the click lands twice
              // and the card closes as soon as it opens.
              event.stopPropagation();
              onToggle();
            }}
            aria-expanded={expanded}
            aria-label={expanded ? 'Collapse question' : 'Expand question'}
            disabled={!selectable}
          >
            <Chevron direction={expanded ? 'up' : 'down'} />
          </button>
        </span>
      </div>

      {expanded && hasFeedback ? (
        <div className={styles.feedback}>
          <span className={styles.feedbackTitle}>AI Feedback</span>
          <p className={styles.feedbackBody}>{grade?.feedback}</p>
        </div>
      ) : null}
    </div>
  );
}

type Verdict = {
  label: string;
  tone: 'tagCorrect' | 'tagPartial' | 'tagIncorrect' | null;
};

/** What the marks say about this answer, or why there are none. */
function correctnessOf(grade: GradeItem | null): Verdict | null {
  if (!grade) return null;

  if (grade.status === 'FAILED') return { label: 'Could not be marked', tone: null };

  if (grade.status === 'NOT_GRADEABLE') {
    return {
      label:
        grade.notGradeableReason === 'MARK_SCHEME_UNAVAILABLE'
          ? 'No marks to grade against'
          : 'Not gradeable',
      tone: null,
    };
  }

  if (grade.awardedMarks === null || grade.maximumMarks === null) return null;

  if (grade.awardedMarks >= grade.maximumMarks) return { label: 'Correct', tone: 'tagCorrect' };
  if (grade.awardedMarks <= 0) return { label: 'Incorrect', tone: 'tagIncorrect' };

  return { label: 'Partially correct', tone: 'tagPartial' };
}
