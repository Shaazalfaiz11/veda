import Image from 'next/image';
import type { ButtonHTMLAttributes, ReactNode } from 'react';
import styles from './PrimaryButton.module.css';

interface PrimaryButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  children: ReactNode;
  /** Swaps the trailing arrow for a spinner and blocks further clicks. */
  busy?: boolean;
}

/** The dark pill button from Figma `1:8791`. */
export function PrimaryButton({
  children,
  busy = false,
  disabled,
  className,
  ...rest
}: PrimaryButtonProps) {
  return (
    <button
      type="button"
      className={[styles.button, className].filter(Boolean).join(' ')}
      disabled={disabled || busy}
      {...rest}
    >
      <span className={styles.label}>{children}</span>
      {busy ? (
        <span className={styles.spinner} aria-hidden="true" />
      ) : (
        <Image
          className={styles.icon}
          src="/figma/icon-arrow-right.svg"
          alt=""
          width={20}
          height={20}
        />
      )}
    </button>
  );
}
