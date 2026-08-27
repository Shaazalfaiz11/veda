import type { ReactNode } from 'react';
import { Header } from './Header';
import { Sidebar } from './Sidebar';
import styles from './AppShell.module.css';

/**
 * Sidebar + header + content, the frame every screen in the Figma file sits
 * inside. Both chrome pieces are identical across the Upload, Loading and
 * Mapping frames, so they live here rather than being repeated per screen.
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

  return (
    <div
      className={[styles.shell, collapsed ? styles.shellCollapsed : '', fill ? styles.shellFill : '']
        .filter(Boolean)
        .join(' ')}
    >
      <div className={styles.sidebarSlot}>
        <Sidebar collapsed={collapsed} />
      </div>
      <div className={styles.main}>
        <Header crumb={crumb} />
        <div className={styles.content}>{children}</div>
      </div>
    </div>
  );
}
