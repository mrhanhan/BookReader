import { screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { afterEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { MeDto } from '@bookr/shared';
import { getTokens, setTokens, TOKEN_STORAGE_KEY } from '../../../api/client';
import { OFFLINE_LOGIN_NOTICE, PROFILE_STORAGE_KEY } from '../../../app/auth';
import { routes } from '../../../app/router';
import { renderWithProviders, server } from '../../../../test/setup';

const tokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token-which-is-long-enough',
  expiresIn: 900,
};

const cachedUser: MeDto = {
  id: 'user-reader',
  username: 'reader',
  displayName: '读者',
  role: 'member',
  timezone: 'Asia/Shanghai',
  aiEnabled: false,
  uploadUsedBytes: 0,
  uploadQuotaBytes: 1024,
  libraryUsedBytes: 0,
  libraryQuotaBytes: 4096,
};

afterEach(() => {
  delete (navigator as { onLine?: boolean }).onLine;
});

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

it('keeps a cached session usable when the app starts offline', async () => {
  setTokens(tokens);
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(cachedUser));
  setOnline(false);
  server.use(http.get('/api/auth/me', () => HttpResponse.error()));

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  // The cached profile signs the user into the shelf instead of /login.
  expect(await screen.findByText('深入理解计算机系统')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  expect(getTokens()).not.toBeNull();
  expect(localStorage.getItem(PROFILE_STORAGE_KEY)).not.toBeNull();
});

it('restores the cached profile when the first request fails at the transport layer', async () => {
  setTokens(tokens);
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(cachedUser));
  // `navigator.onLine` still reports true; fetch itself rejects (TypeError).
  server.use(http.get('/api/auth/me', () => HttpResponse.error()));

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText('深入理解计算机系统')).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/');
  expect(getTokens()).not.toBeNull();
});

it('ends the session when the API explicitly rejects the stored tokens', async () => {
  setTokens(tokens);
  localStorage.setItem(PROFILE_STORAGE_KEY, JSON.stringify(cachedUser));
  const unauthorized = () =>
    HttpResponse.json(
      { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
      { status: 401 },
    );
  server.use(
    http.get('/api/auth/me', unauthorized),
    http.post('/api/auth/refresh', unauthorized),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  await waitFor(() => expect(router.state.location.pathname).toBe('/login'));
  expect(localStorage.getItem(TOKEN_STORAGE_KEY)).toBeNull();
  // A rejected session must not leave a profile behind for the next start.
  expect(localStorage.getItem(PROFILE_STORAGE_KEY)).toBeNull();
});

it('asks for an online sign-in when offline without a cached profile', async () => {
  setTokens(tokens);
  setOnline(false);
  server.use(http.get('/api/auth/me', () => HttpResponse.error()));

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText(OFFLINE_LOGIN_NOTICE)).toBeInTheDocument();
  expect(router.state.location.pathname).toBe('/login');
  expect(getTokens()).toBeNull();
});
