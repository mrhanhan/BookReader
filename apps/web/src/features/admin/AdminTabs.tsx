import { cn } from '@bookr/ui';
import { NavLink } from 'react-router';

/** The four administration sections, in task order. */
const ADMIN_TABS = [
  { to: '/admin/members', label: '成员' },
  { to: '/admin/settings', label: '设置' },
  { to: '/admin/audit', label: '审计' },
  { to: '/admin/backups', label: '备份' },
] as const;

/**
 * Shared section switcher. `NavLink` marks the current entry with
 * `aria-current="page"`; the row wraps on 360px screens instead of scrolling.
 */
export function AdminTabs() {
  return (
    <nav
      aria-label="管理导航"
      className="flex flex-wrap items-center gap-1.5 border-b border-border pb-2"
    >
      {ADMIN_TABS.map((tab) => (
        <NavLink
          key={tab.to}
          to={tab.to}
          end
          className={({ isActive }) =>
            cn(
              'rounded-md px-3 py-1.5 text-sm transition',
              isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink/5 hover:text-ink',
            )
          }
        >
          {tab.label}
        </NavLink>
      ))}
    </nav>
  );
}
