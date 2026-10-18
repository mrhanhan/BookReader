import { createBrowserRouter, Navigate, Outlet, useLocation } from 'react-router';
import type { RouteObject } from 'react-router';
import { LoginPage } from '../features/auth/LoginPage';
import { RegisterPage } from '../features/auth/RegisterPage';
import { BookshelfPage } from '../features/bookshelf/BookshelfPage';
import { TrashPage } from '../features/bookshelf/TrashPage';
import { AppLayout } from './AppLayout';
import { useAuth } from './auth';
import { AdminPage } from './pages';

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

/** Route table shared by the browser router and `createMemoryRouter` in tests. */
export const routes: RouteObject[] = [
  { path: '/login', element: <LoginPage /> },
  { path: '/register', element: <RegisterPage /> },
  {
    element: <RequireAuth />,
    children: [
      {
        element: <AppLayout />,
        children: [
          { index: true, element: <BookshelfPage /> },
          { path: 'trash', element: <TrashPage /> },
          { path: 'admin', element: <AdminPage /> },
        ],
      },
    ],
  },
  { path: '*', element: <Navigate to="/" replace /> },
];

export function createAppRouter() {
  return createBrowserRouter(routes);
}
