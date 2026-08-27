import Image from 'next/image';
import styles from './HeroAvatar.module.css';

/**
 * The illustration at the centre of the upload screen (Figma `1:8756`).
 *
 * Purely decorative, so every layer is `alt=""` and the whole thing is hidden
 * from assistive technology — a screen reader gains nothing from four
 * unlabelled gradient dots.
 */
export function HeroAvatar() {
  return (
    <div className={styles.hero} aria-hidden="true">
      <div className={styles.rings}>
        <Image
          className={styles.ringOuter}
          src="/figma/hero-ring-outer.svg"
          alt=""
          width={139}
          height={139}
        />
        <Image
          className={styles.ringInner}
          src="/figma/hero-ring-inner.svg"
          alt=""
          width={109}
          height={109}
        />
        <Image
          className={styles.shoulders}
          src="/figma/hero-ellipse-3.svg"
          alt=""
          width={79}
          height={78}
        />
        <span className={styles.collar}>
          <Image
            className={styles.collarArt}
            src="/figma/hero-ellipse-4.svg"
            alt=""
            width={69}
            height={83}
          />
        </span>
        <Image
          className={styles.portrait}
          src="/figma/hero-teacher.png"
          alt=""
          width={79}
          height={97}
          priority
        />
      </div>

      <div className={styles.orbit}>
        <span className={`${styles.badge} ${styles.badgeTask}`}>
          <Image
            className={styles.badgeIcon}
            src="/figma/icon-task-square.svg"
            alt=""
            width={7}
            height={7}
          />
        </span>
        <span className={`${styles.badge} ${styles.badgeCloud}`}>
          <Image
            className={styles.badgeIcon}
            src="/figma/icon-cloud-lightning.svg"
            alt=""
            width={7}
            height={7}
          />
        </span>
        <span className={`${styles.badge} ${styles.badgeClock}`}>
          <Image
            className={styles.badgeIcon}
            src="/figma/icon-clock.svg"
            alt=""
            width={7}
            height={7}
          />
        </span>
        <span className={`${styles.badge} ${styles.badgeSettings}`}>
          <Image
            className={styles.badgeIcon}
            src="/figma/icon-settings-small.svg"
            alt=""
            width={7}
            height={7}
          />
        </span>
      </div>
    </div>
  );
}
