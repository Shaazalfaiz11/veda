import Image from 'next/image';
import styles from './Sidebar.module.css';

/**
 * The left navigation.
 *
 * Two variants, both from the Figma file: expanded (`I1:8796`, 304px, used by
 * the Upload frames) and collapsed (`1:10146`, 64px, used by the Loading
 * frame). They are one component because the rows, the active state and the
 * order are identical — only the labels and the widths differ.
 *
 * The navigation targets are the design's, not the app's — this build
 * implements the Exams flow, so the other entries are present because the
 * design shows them, and are inert rather than linking somewhere invented.
 *
 * Note: the collapsed frame highlights *Home* while the expanded frames
 * highlight *Exams*. That looks like a slip in the design rather than intent —
 * the loading screen is reached from the Exams flow — so the active row is
 * driven by where the user actually is, and stays on Exams in both.
 */

interface NavItem {
  label: string;
  icon: string;
  /** Only Exams is reachable in this build; the rest are design furniture. */
  active?: boolean;
  /** Per-row height in the collapsed frame, which varies row to row. */
  collapsedClass: string;
}

const NAV_ITEMS: NavItem[] = [
  {
    label: 'Home',
    icon: '/figma/icon-nav-home.svg',
    collapsedClass: styles.itemCollapsedHome!,
  },
  {
    label: 'My Classroom',
    icon: '/figma/icon-nav-classroom.svg',
    collapsedClass: styles.itemCollapsedClassroom!,
  },
  {
    label: 'Assignments',
    icon: '/figma/icon-nav-assignments.svg',
    collapsedClass: styles.itemCollapsedAssignments!,
  },
  {
    label: 'Exams',
    icon: '/figma/icon-nav-exams.svg',
    active: true,
    collapsedClass: styles.itemCollapsedExams!,
  },
  {
    label: 'My Library',
    icon: '/figma/icon-nav-library.svg',
    collapsedClass: styles.itemCollapsedLibrary!,
  },
];

export function Sidebar({ collapsed = false }: { collapsed?: boolean }) {
  return (
    <aside className={`${styles.sidebar} ${collapsed ? styles.sidebarCollapsed : ''}`}>
      <div className={styles.top}>
        <div className={styles.brandRow}>
          <div className={styles.brand}>
            <Image
              className={styles.brandMark}
              src="/figma/logo-vedaai.svg"
              alt=""
              width={40}
              height={40}
              priority
            />
            {collapsed ? null : <span className={styles.brandName}>VedaAI</span>}
          </div>
          {collapsed ? null : (
            <Image
              className={styles.collapse}
              src="/figma/icon-sidebar-collapse.svg"
              alt=""
              width={20}
              height={20}
            />
          )}
        </div>

        <button type="button" className={styles.toolkit}>
          <Image
            className={styles.toolkitIcon}
            src="/figma/icon-toolkit-sparkle.svg"
            alt=""
            width={19}
            height={18}
          />
          {collapsed ? null : (
            <span className={styles.toolkitLabel}>AI Teacher&rsquo;s Toolkit</span>
          )}
        </button>

        <nav className={styles.menu}>
          {NAV_ITEMS.map((item) => (
            <div
              key={item.label}
              className={[
                styles.item,
                item.active ? styles.itemActive : '',
                collapsed ? item.collapsedClass : '',
              ]
                .filter(Boolean)
                .join(' ')}
              aria-current={item.active ? 'page' : undefined}
              title={collapsed ? item.label : undefined}
            >
              <Image
                className={styles.itemIcon}
                src={item.icon}
                alt=""
                width={20}
                height={20}
              />
              {collapsed ? null : <span className={styles.itemLabel}>{item.label}</span>}
            </div>
          ))}
        </nav>
      </div>

      <div className={styles.bottom}>
        {collapsed ? null : (
          <div className={styles.item}>
            <Image
              className={styles.itemIcon}
              src="/figma/icon-nav-settings.svg"
              alt=""
              width={20}
              height={20}
            />
            <span className={styles.itemLabel}>Settings</span>
          </div>
        )}

        {collapsed ? (
          <>
            <div className={styles.schoolTile}>
              <span className={styles.schoolTileFrame}>
                <Image
                  className={styles.schoolMark}
                  src="/figma/logo-school.png"
                  alt=""
                  width={229}
                  height={46}
                />
              </span>
            </div>
            <button type="button" className={styles.expand} aria-label="Expand navigation">
              <Image
                className={styles.expandIcon}
                src="/figma/icon-chevrons-right.svg"
                alt=""
                width={20}
                height={20}
              />
            </button>
          </>
        ) : (
          <div className={styles.school}>
            <span className={styles.schoolMarkFrame}>
              <Image
                className={styles.schoolMark}
                src="/figma/logo-school.png"
                alt=""
                width={318}
                height={64}
              />
            </span>
            <div className={styles.schoolText}>
              <span className={styles.schoolName}>Delhi Public School</span>
              <span className={styles.schoolCity}>Bokaro Steel City</span>
            </div>
          </div>
        )}
      </div>
    </aside>
  );
}
