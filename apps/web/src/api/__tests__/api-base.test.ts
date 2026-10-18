import { expect, it } from 'vitest';
import { resolveApiBase } from '../client';

it('keeps same-origin paths and normalizes an absolute API origin', () => {
  expect(resolveApiBase(undefined)).toBe('');
  expect(resolveApiBase('')).toBe('');
  expect(resolveApiBase('https://bookr.example.com/')).toBe('https://bookr.example.com');
  expect(resolveApiBase('https://bookr.example.com/api')).toBe('https://bookr.example.com/api');
});
