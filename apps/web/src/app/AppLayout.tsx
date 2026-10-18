import { useState } from 'react';
import { NavLink, Outlet, useNavigate } from 'react-router';
import { Button, cn } from '@bookr/ui';
import { useAuth } from './auth';

const NAV_ITEMS = [
  { to: '/', label: '书架', end: true },
  { to: '/trash', label: '回收站', end: false },
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
      <header className="border-b border-border/80 bg-surface/80 backdrop-blur">
        <div className="mx-auto flex max-w-6xl items-center gap-6 px-4 py-3">
          <NavLink to="/" className="font-serif text-lg tracking-wide text-ink">
            纸墨书房
          </NavLink>
          <nav aria-label="主导航" className="flex items-center gap-1 text-sm">
            {navItems.map((item) => (
              <NavLink
                key={item.to}
                to={item.to}
                end={item.end}
                className={({ isActive }) =>
                  cn(
                    'rounded-md px-3 py-1.5 transition',
                    isActive ? 'bg-accent/10 text-accent' : 'text-muted hover:bg-ink/5 hover:text-ink',
                  )
                }
              >
                {item.label}
              </NavLink>
            ))}
          </nav>
          <div className="ml-auto flex items-center gap-3 text-sm text-muted">
            <span>{user?.displayName ?? user?.username}</span>
            <Button variant="ghost" size="sm" loading={loggingOut} onClick={handleLogout}>
              退出登录
            </Button>
          </div>
        </div>
      </header>
      <main className="mx-auto max-w-6xl px-4 py-8">
        <Outlet />
      </main>
    </div>
  );
}
