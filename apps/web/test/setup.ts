import '@testing-library/jest-dom/vitest';
import { LIBRARY_QUOTA_BYTES, MEMBER_UPLOAD_QUOTA_BYTES } from '@bookr/shared';
import type { AuthTokens, MeDto } from '@bookr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { AuthProvider } from '../src/app/auth';

const tokens: AuthTokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token-which-is-long-enough',
  expiresIn: 900,
};

const reader: MeDto = {
  id: 'user-reader',
  username: 'reader',
  displayName: '读者',
  role: 'member',
  timezone: 'Asia/Shanghai',
  aiEnabled: false,
  uploadUsedBytes: 0,
  uploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
  libraryUsedBytes: 0,
  libraryQuotaBytes: LIBRARY_QUOTA_BYTES,
};

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });

export const handlers = [
  http.post('/api/auth/login', async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
    if (body.username === 'reader' && body.password === 'correct-password') {
      return HttpResponse.json(tokens);
    }
    return error(401, 'UNAUTHORIZED', '用户名或密码错误');
  }),
  http.post('/api/auth/register', () => HttpResponse.json(tokens, { status: 201 })),
  http.post('/api/auth/refresh', () => HttpResponse.json(tokens)),
  http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
  http.get('/api/auth/me', () => HttpResponse.json(reader)),
  // Placeholders for the shared bookshelf, trash and category endpoints. The
  // auth task does not render them, but keeping them here means later tasks can
  // extend the same MSW server instead of re-creating it.
  http.get('/api/books', () => HttpResponse.json({ items: [], total: 0 })),
  http.get('/api/trash', () => HttpResponse.json({ items: [] })),
  http.get('/api/categories', () => HttpResponse.json({ items: [] })),
];

export const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  localStorage.clear();
});

afterAll(() => {
  server.close();
});

/** Renders a subtree with the query client and auth context the app expects. */
export function renderWithProviders(ui: ReactElement): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    queryClient,
    ...render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuthProvider, null, ui),
      ),
    ),
  };
}
