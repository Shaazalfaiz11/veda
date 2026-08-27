import styles from './ScoreBadge.module.css';

/**
 * The marks pill on a question card.
 *
 * Three variants, all taken from the design: full marks (`12:397`), partial
 * (`12:445`) and zero (`12:406`). Which one shows is derived from the marks
 * themselves rather than passed in, so it can never disagree with the number
 * printed next to it.
 */
export function ScoreBadge({
  awarded,
  maximum,
}: {
  awarded: number | null;
  maximum: number | null;
}) {
  // No marks at all is not zero marks — an ungraded answer has not scored
  // nothing, it has not been scored. The design has no pill for this, so it
  // gets a muted one rather than a green or red claim.
  if (awarded === null || maximum === null) {
    return <span className={`${styles.badge} ${styles.none}`}>Not marked</span>;
  }

  const tone =
    awarded >= maximum ? styles.full : awarded <= 0 ? styles.zero : styles.partial;

  return (
    <span className={`${styles.badge} ${tone}`}>
      {awarded} / {maximum}
    </span>
  );
}
