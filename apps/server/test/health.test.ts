import { expect, it } from 'vitest';
import { buildTestApp } from './helpers';

it('returns ok on healthz', async () => {
  const app = await buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({ status: 'ok' });
});
it('wraps unknown routes in the error envelope', async () => {
  const app = await buildTestApp();
  const res = await app.inject({ method: 'GET', url: '/api/nope' });
  expect(res.statusCode).toBe(404);
  expect(res.json().error.code).toBe('NOT_FOUND');
});
it('preserves Fastify 4xx errors instead of masking them as 500', async () => {
  const app = await buildTestApp();
  app.post('/api/echo', async (request) => request.body);
  const res = await app.inject({
    method: 'POST',
    url: '/api/echo',
    headers: { 'content-type': 'application/json' },
    payload: '{"broken":',
  });
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('VALIDATION_FAILED');
});
