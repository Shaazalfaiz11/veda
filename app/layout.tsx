import type { Metadata } from 'next';
import type { ReactNode } from 'react';
import { Bricolage_Grotesque, Inter } from 'next/font/google';
import './globals.css';

/**
 * Bricolage Grotesque is the typeface the Figma file uses throughout. It is a
 * variable font with `opsz`, `wdth` and `wght` axes; the design is drawn at
 * `opsz 14, wdth 100`, which `globals.css` pins on the body. Loading the axes
 * here rather than substituting a lookalike is what keeps text metrics --
 * and therefore every measured width in the design -- correct.
 */
const bricolage = Bricolage_Grotesque({
  subsets: ['latin'],
  axes: ['opsz', 'wdth'],
  display: 'swap',
  variable: '--font-bricolage',
});

/** Used only by the "AI Teacher's Toolkit" button, which the design sets in Inter. */
const inter = Inter({
  subsets: ['latin'],
  display: 'swap',
  variable: '--font-inter',
});

export const metadata: Metadata = {
  title: 'VedaAI — Assessment Processing',
  description: 'AI assessment extraction and answer mapping.',
};

export default function RootLayout({ children }: { children: ReactNode }) {
  return (
    <html lang="en" className={`${bricolage.variable} ${inter.variable}`}>
      <body>{children}</body>
    </html>
  );
}
