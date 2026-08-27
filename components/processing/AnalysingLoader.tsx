import Image from 'next/image';
import styles from './AnalysingLoader.module.css';

/**
 * The centred sparkle loader from Figma `1:10254`.
 *
 * Presentation only — it takes the headline and subtext it should show and
 * knows nothing about polling, so the same component covers every stage.
 */
export function AnalysingLoader({
  headline,
  subtext,
}: {
  headline: string;
  subtext: string;
}) {
  return (
    <div className={styles.loader}>
      <div className={styles.icon} aria-hidden="true">
        <Image
          className={`${styles.layer} ${styles.layerStarLarge} ${styles.pulse}`}
          src="/figma/loader-star-1.svg"
          alt=""
          width={96}
          height={96}
          priority
        />
        <Image
          className={`${styles.layer} ${styles.layerStarMedium} ${styles.pulse} ${styles.pulseDelayed}`}
          src="/figma/loader-star-2.svg"
          alt=""
          width={72}
          height={72}
          priority
        />
        <Image
          className={`${styles.layer} ${styles.layerStarSmall} ${styles.pulse}`}
          src="/figma/loader-star-3.svg"
          alt=""
          width={29}
          height={29}
        />
        <Image
          className={`${styles.layer} ${styles.layerDot} ${styles.pulse} ${styles.pulseDelayed}`}
          src="/figma/loader-dot.svg"
          alt=""
          width={13}
          height={13}
        />
      </div>

      <div className={styles.text}>
        {/* aria-live so a screen reader hears the stage change without the
            page having to move focus. */}
        <p className={styles.headline} aria-live="polite">
          {headline}
        </p>
        <p className={styles.subtext}>{subtext}</p>
      </div>
    </div>
  );
}
