'use client';

import Image from 'next/image';
import { useRouter } from 'next/navigation';
import styles from './Header.module.css';

/**
 * The top bar, from Figma node `1:8795`.
 *
 * The design's back button contains two overlapping arrow glyphs — a
 * component quirk where the second is clipped out of view. Only the visible
 * one is rendered.
 *
 * `ChevronDown` comes back from Figma as a Code Connect reference to the
 * Simple Design System, which this project does not depend on, so it is drawn
 * inline at the size the design specifies.
 */

interface HeaderProps {
  /** Breadcrumb label. The design shows "Exams". */
  crumb?: string;
  userName?: string;
  /** Opens the drawer. Only rendered where the sidebar is not on screen. */
  onMenu?: () => void;
}

export function Header({ crumb = 'Exams', userName = 'Shaaz Alfaiz', onMenu }: HeaderProps) {
  const router = useRouter();

  return (
    <header className={styles.header}>
      {onMenu ? (
        <button
          type="button"
          className={styles.menu}
          onClick={onMenu}
          aria-label="Open menu"
        >
          {/* Three bars, drawn rather than imported: the Figma file has no
              phone header, so there is no exported asset for this. */}
          <span className={styles.menuBars} aria-hidden="true" />
        </button>
      ) : null}

      <button type="button" className={styles.back} onClick={() => router.back()} aria-label="Go back">
        <Image
          className={styles.backIcon}
          src="/figma/icon-arrow-left.svg"
          alt=""
          width={24}
          height={24}
        />
      </button>

      <div className={styles.crumb}>
        <Image
          className={styles.crumbIcon}
          src="/figma/icon-header-exams.svg"
          alt=""
          width={20}
          height={20}
        />
        <span className={styles.crumbLabel}>{crumb}</span>
      </div>

      <button type="button" className={styles.help} aria-label="Help">
        <span className={styles.helpRing}>?</span>
      </button>

      <Image
        className={styles.action}
        src="/figma/icon-bell.svg"
        alt="Notifications"
        width={36}
        height={36}
      />
      <Image
        className={styles.action}
        src="/figma/icon-sparkle.svg"
        alt="AI actions"
        width={36}
        height={36}
      />

      <button type="button" className={styles.user}>
        <Image
          className={styles.avatar}
          src="/figma/avatar-user.png"
          alt=""
          width={32}
          height={32}
        />
        <span className={styles.userName}>{userName}</span>
        <svg
          className={styles.chevron}
          viewBox="0 0 16 16"
          fill="none"
          aria-hidden="true"
        >
          <path
            d="M4 6l4 4 4-4"
            stroke="currentColor"
            strokeWidth="1.5"
            strokeLinecap="round"
            strokeLinejoin="round"
          />
        </svg>
      </button>
    </header>
  );
}
