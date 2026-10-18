import { afterEach, expect, it, vi } from 'vitest';
import { apiUrl, resolveApiBase } from '../client';

afterEach(() => {
  vi.unstubAllEnvs();
  vi.resetModules();
});

it('keeps same-origin paths and normalizes an absolute API origin', () => {
  expect(resolveApiBase(undefined)).toBe('');
  expect(resolveApiBase('')).toBe('');
  expect(resolveApiBase('https://bookr.example.com/')).toBe('https://bookr.example.com');
  expect(resolveApiBase('https://bookr.example.com/api')).toBe('https://bookr.example.com/api');
  expect(resolveApiBase('https://x//')).toBe('https://x');
});

it('keeps same-origin paths and passes absolute URLs through', () => {
  expect(apiUrl('/api/x')).toBe('/api/x');
  expect(apiUrl('https://files.test/x')).toBe('https://files.test/x');
});

it('prefixes API paths with the configured origin', async () => {
  vi.stubEnv('VITE_API_BASE_URL', 'https://bookr.example.com//');
  vi.resetModules();
  const client = await import('../client');
  expect(client.apiUrl('/api/x')).toBe('https://bookr.example.com/api/x');
  expect(client.apiUrl('https://files.test/x')).toBe('https://files.test/x');
});
