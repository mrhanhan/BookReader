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
