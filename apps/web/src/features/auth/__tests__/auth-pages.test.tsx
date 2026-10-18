import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
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

it('clears cached queries when logging out', async () => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  const { queryClient } = renderWithProviders(<RouterProvider router={router} />);

  await screen.findByText('书架还是空的');
  queryClient.setQueryData(['books'], [{ id: 'cached-book' }]);

  await userEvent.click(screen.getByRole('button', { name: '退出登录' }));

  await waitFor(() => expect(queryClient.getQueryData(['books'])).toBeUndefined());
  expect(router.state.location.pathname).toBe('/login');
});
