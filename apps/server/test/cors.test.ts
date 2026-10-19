import { expect, it } from 'vitest';
import { buildTestApp } from './helpers';

it('allows every configured app origin and rejects the rest', async () => {
  const app = await buildTestApp({
    corsOrigins: ['http://localhost:8180', 'https://tauri.localhost'],
  });
  const allowed = await app.inject({
    method: 'GET', url: '/healthz', headers: { origin: 'https://tauri.localhost' },
  });
  const rejected = await app.inject({
    method: 'GET', url: '/healthz', headers: { origin: 'https://evil.example' },
  });
  expect(allowed.headers['access-control-allow-origin']).toBe('https://tauri.localhost');
  // Native shells must be able to read the export filename from a cross-origin response.
  expect(allowed.headers['access-control-expose-headers']).toContain('Content-Disposition');
  expect(rejected.headers['access-control-allow-origin']).toBeUndefined();
});
