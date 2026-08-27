'use client';

import { useCallback, useEffect, useState, type ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

/**
 * Sidebar + header + content, the frame every screen in the Figma file sits
 * inside. Both chrome pieces are identical across the Upload, Loading and
 * Mapping frames, so they live here rather than being repeated per screen.
 *
 * Below 900px the sidebar cannot hold its 304px beside the content — the
 * phone frames drop it entirely and give the width to the screen. It moves
 * into a drawer behind the header's menu button rather than disappearing, so
 * the brand and the section a teacher is in stay reachable on a phone. The
 * drawer renders the same `Sidebar`, so there is one navigation to maintain.
 */
interface AppShellProps {
  children: ReactNode;
  crumb?: string;
  /**
   * The Loading frame uses the collapsed 64px sidebar and slightly different
   * gutters; the Upload frames use the expanded 304px one.
   */
  sidebar?: 'expanded' | 'collapsed';
  /**
   * Pin the shell to the viewport so the screen's own panes scroll rather
   * than the page. Used by the mapping split.
   */
  fill?: boolean;
}

export function AppShell({ children, crumb, sidebar = 'expanded', fill = false }: AppShellProps) {
  const collapsed = sidebar === 'collapsed';
  const [menuOpen, setMenuOpen] = useState(false);

  const close = useCallback(() => setMenuOpen(false), []);

  // Escape closes it, as a dialog should. Nothing is focus-trapped: the drawer
  // holds the whole navigation, and trapping would strand a keyboard user in
  // it on a viewport where the rest of the page is still perfectly usable.
  useEffect(() => {
    if (!menuOpen) return;

    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') close();
    };

    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [menuOpen, close]);

  // A drawer that stays mounted while the window grows back to desktop would
  // leave a backdrop over a layout that already shows the sidebar.
  useEffect(() => {
    const wide = window.matchMedia('(min-width: 901px)');
    const onChange = () => {
      if (wide.matches) close();
    };

    wide.addEventListener('change', onChange);
    return () => wide.removeEventListener('change', onChange);
  }, [close]);

  return (
    <div
      className={[styles.shell, collapsed ? styles.shellCollapsed : '', fill ? styles.shellFill : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.sidebarSlot}>
        <Sidebar collapsed={collapsed} />
      </div>

      {menuOpen ? (
        <>
          <button
            type="button"
            className={styles.scrim}
            aria-label="Close menu"
            onClick={close}
          />
          <div className={styles.drawer} role="dialog" aria-modal="true" aria-label="Menu">
            <div className={styles.drawerInner}>
              <Sidebar />
            </div>
            <button type="button" className={styles.drawerClose} onClick={close}>
              Close
            </button>
          </div>
        </>
      ) : null}

      <div className={styles.main}>
        <Header crumb={crumb} onMenu={() => setMenuOpen(true)} />
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
