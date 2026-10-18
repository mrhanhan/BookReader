import { describe, expect, it } from 'vitest';
import { newId } from '../ids';

it('returns a UUIDv7', () => {
  const id = newId();
  expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
});
it('returns unique ids', () => {
  expect(new Set(Array.from({ length: 1000 }, newId)).size).toBe(1000);
});
