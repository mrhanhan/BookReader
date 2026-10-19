import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { PROGRESS_KEY_PREFIX } from '../../reader/progressStore';
import { renderWithProviders, server } from '../../../../test/setup';

it('redirects an unauthenticated visitor from / to /login', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
});

it('shows an error when login fails', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.type(screen.getByLabelText('用户名'), 'reader');
  await userEvent.type(screen.getByLabelText('密码'), 'a-long-password');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));
  expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument();
});

it('localizes an English unauthorized message from the server', async () => {
  server.use(
    http.post('/api/auth/login', () =>
      HttpResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 },
      ),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/login'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.type(screen.getByLabelText('用户名'), 'reader');
  await userEvent.type(screen.getByLabelText('密码'), 'wrong-password');
  await userEvent.click(screen.getByRole('button', { name: '登录' }));

  expect(await screen.findByText('用户名或密码错误')).toBeInTheDocument();
  expect(screen.queryByText('Authentication required')).not.toBeInTheDocument();
});

it('shows the registration-closed message for a 403 FORBIDDEN response', async () => {
  server.use(
    http.post('/api/auth/register', () =>
      HttpResponse.json(
        { error: { code: 'FORBIDDEN', message: 'Registration is closed' } },
        { status: 403 },
      ),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/register'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.type(screen.getByLabelText('邀请码'), 'invite-123456');
  await userEvent.type(screen.getByLabelText('用户名'), 'reader');
  await userEvent.type(screen.getByLabelText('显示名称'), '读者');
  await userEvent.type(screen.getByLabelText('密码'), 'a-long-password');
  await userEvent.click(screen.getByRole('button', { name: '注册' }));

  expect(await screen.findByText('注册暂未开放，请联系管理员')).toBeInTheDocument();
  // The generic FORBIDDEN copy must not mask the registration-specific reason.
  expect(screen.queryByText('没有权限执行此操作')).not.toBeInTheDocument();
});

it('clears cached queries when logging out', async () => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  const { queryClient } = renderWithProviders(<RouterProvider router={router} />);

  // Wait until the stored session has been verified and the app shell is up.
  await screen.findByRole('button', { name: '退出登录' });
  queryClient.setQueryData(['books'], [{ id: 'cached-book' }]);
  const legacyKey = `${PROGRESS_KEY_PREFIX}user-reader.cached-book`;
  localStorage.setItem(
    legacyKey,
    JSON.stringify({
      locator: { kind: 'pdf', page: 4, percent: 0.3 },
      savedAt: Date.now(),
    }),
  );

  await userEvent.click(screen.getByRole('button', { name: '退出登录' }));

  await waitFor(() => expect(queryClient.getQueryData(['books'])).toBeUndefined());
  // The next account must not inherit this browser's cached position.
  expect(localStorage.getItem(legacyKey)).toBeNull();
  expect(router.state.location.pathname).toBe('/login');
});
