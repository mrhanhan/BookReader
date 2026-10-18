import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';

// The admin page lives behind RequireAuth, so seed a stored session first.
beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
});

/** Overrides `/api/auth/me` with an administrator for the duration of one test. */
function signInAsAdmin() {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({
        id: 'user-admin',
        username: 'admin',
        displayName: '掌灯人',
        role: 'admin',
        timezone: 'Asia/Shanghai',
        aiEnabled: false,
        uploadUsedBytes: 0,
        uploadQuotaBytes: 20 * 1024 * 1024 * 1024,
        libraryUsedBytes: 0,
        libraryQuotaBytes: 80 * 1024 * 1024 * 1024,
      }),
    ),
  );
}

it('lists members and creates an invite code for admins', async () => {
  signInAsAdmin();
  server.use(
    http.get('/api/admin/members', () =>
      HttpResponse.json({
        items: [
          {
            id: 'u1',
            username: 'alice',
            displayName: 'Alice',
            role: 'member',
            isActive: true,
            uploadQuotaBytes: 1000,
            usedBytes: 300,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    ),
  );
  server.use(
    http.post('/api/admin/invites', () =>
      HttpResponse.json(
        { code: 'ABCD234567', expiresAt: new Date().toISOString() },
        { status: 201 },
      ),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText('Alice')).toBeInTheDocument();
  // The admin-only nav link appears for administrators.
  expect(screen.getByRole('link', { name: '管理' })).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '生成邀请码' }));
  expect(await screen.findByText('ABCD234567')).toBeInTheDocument();
});

it('redirects members away from the admin page', async () => {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ id: 'u2', username: 'bob', displayName: 'Bob', role: 'member' }),
    ),
  );
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);

  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  // Members never see the administration entry point.
  expect(screen.queryByRole('link', { name: '管理' })).toBeNull();
});
