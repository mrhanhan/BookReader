import { http, HttpResponse } from 'msw';
import { expect, it } from 'vitest';
import { server } from '../../../test/setup';
import { apiFetch, getTokens, setTokens } from '../client';

it('refreshes a rotated token once for concurrent 401 responses', async () => {
  const stale = {
    accessToken: 'stale-access-token',
    refreshToken: 'stale-refresh-token',
    expiresIn: 900,
  };
  const fresh = {
    accessToken: 'fresh-access-token',
    refreshToken: 'fresh-refresh-token',
    expiresIn: 900,
  };
  setTokens(stale);

  let refreshCalls = 0;
  server.use(
    http.post('/api/auth/refresh', () => {
      refreshCalls += 1;
      return HttpResponse.json(fresh);
    }),
    http.get('/api/books', ({ request }) => {
      if (request.headers.get('Authorization') === `Bearer ${fresh.accessToken}`) {
        return HttpResponse.json({ items: [], total: 0 });
      }
      return HttpResponse.json(
        { error: { code: 'UNAUTHORIZED', message: 'Authentication required' } },
        { status: 401 },
      );
    }),
  );

  const [first, second] = await Promise.all([
    apiFetch<{ items: unknown[]; total: number }>('/api/books'),
    apiFetch<{ items: unknown[]; total: number }>('/api/books'),
  ]);

  expect(refreshCalls).toBe(1);
  expect(first).toEqual({ items: [], total: 0 });
  expect(second).toEqual({ items: [], total: 0 });
  expect(getTokens()?.accessToken).toBe(fresh.accessToken);
});
