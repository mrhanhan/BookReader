import { createBrowserRouter, Navigate, Outlet, useLocation, useParams } from 'react-router';
import type { RouteObject } from 'react-router';
import type { ReactNode } from 'react';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { MembersPage } from '../features/admin/MembersPage';
import { BookshelfPage } from '../features/bookshelf/BookshelfPage';
import { TrashPage } from '../features/bookshelf/TrashPage';
import { ReaderPage } from '../features/reader/ReaderPage';
import { SettingsPage } from '../features/settings/SettingsPage';
import { AppLayout } from './AppLayout';
import { useAuth } from './auth';

function RequireAuth() {
  const { user, loading } = useAuth();
  const location = useLocation();

  if (loading) {
    return (
      <div
        role="status"
        aria-live="polite"
        className="flex min-h-screen items-center justify-center font-serif text-sm tracking-widest text-muted"
      >
        正在打开书房…
      </div>
    );
  }

  if (!user) {
    return <Navigate to="/login" replace state={{ from: location.pathname }} />;
  }

  return <Outlet />;
}

/** Administration is invisible to members, even by direct URL. */
function RequireAdmin({ children }: { children: ReactNode }) {
  const { user, loading } = useAuth();

  if (loading) {
    return (
      <p role="status" className="py-16 text-center text-sm tracking-widest text-muted">
        正在核对名册…
      </p>
    );
  }

  if (user?.role !== 'admin') {
    return <Navigate to="/" replace />;
  }

  return <>{children}</>;
}

/** The shelf's book links still point at `/books/:id`; send them to the reader. */
function BookRedirect() {
  const { id } = useParams<{ id: string }>();
  return <Navigate to={id ? `/books/${id}/read` : '/'} replace />;
}

/** Route table shared by the browser router and `createMemoryRouter` in tests. */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      // The reader owns the whole viewport, so it sits outside `AppLayout`.
      { path: 'books/:id/read', element: <ReaderPage /> },
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <BookshelfPage /> },
          { path: 'books/:id', element: <BookRedirect /> },
          { path: 'trash', element: <TrashPage /> },
          { path: 'settings', element: <SettingsPage /> },
          { path: 'admin', element: <Navigate to="/admin/members" replace /> },
          {
            path: 'admin/members',
            element: (
              <RequireAdmin>
                <MembersPage />
              </RequireAdmin>
            ),
          },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
