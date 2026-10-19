import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Button, cn } from '@bookr/ui';
import { SyncStatusBadge } from '../features/settings/SyncStatusBadge';
import { useAuth } from './auth';

const NAV_ITEMS = [
  { to: '/', label: '书架', end: true },
  { to: '/trash', label: '回收站', end: false },
  { to: '/settings', label: '设置', end: true },
] as const;

/** Administration is only advertised to administrators. */
const ADMIN_NAV_ITEM = { to: '/admin/members', label: '管理', end: false } as const;

export function AppLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const [loggingOut, setLoggingOut] = useState(false);
  const navItems = user?.role === 'admin' ? [...NAV_ITEMS, ADMIN_NAV_ITEM] : NAV_ITEMS;

  async function handleLogout() {
    setLoggingOut(true);
    try {
      await logout();
      navigate('/login', { replace: true });
    } finally {
      setLoggingOut(false);
    }
  }

  return (
    <div className="min-h-screen">
      <header className="sticky top-0 z-30 border-b border-border/80 bg-surface/90 backdrop-blur">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center gap-x-4 gap-y-2 px-4 py-2.5 sm:flex-nowrap sm:py-3">
          <NavLink
            to="/"
            className="shrink-0 whitespace-nowrap font-serif text-lg tracking-wide text-ink"
          >
            纸墨书房
          </NavLink>
          {/* Phones get a second, horizontally scrollable paper-tab row. */}
          <nav
            aria-label="主导航"
            className="-mx-1 order-3 flex w-full items-center gap-1 overflow-x-auto px-1 pb-0.5 [scrollbar-width:none] sm:order-none sm:mx-0 sm:w-auto sm:overflow-visible sm:px-0 sm:pb-0"
          >
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'shrink-0 whitespace-nowrap rounded-md px-3 py-1.5 text-sm transition',
                    isActive
                      ? 'bg-accent/10 text-accent'
                      : 'text-muted hover:bg-ink/5 hover:text-ink',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex shrink-0 items-center gap-2 text-sm text-muted sm:gap-3">
            <SyncStatusBadge />
            <span className="hidden sm:inline">{user?.displayName ?? user?.username}</span>
            <Button variant="ghost" size="sm" loading={loggingOut} onClick={handleLogout}>
              退出登录
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-5 sm:py-8">
        <Outlet />
      </main>
    </div>
  );
}
