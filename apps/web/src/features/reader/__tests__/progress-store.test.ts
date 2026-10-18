import { beforeEach, expect, it } from 'vitest';
import { readLocalProgress, resolveInitialLocator, writeLocalProgress } from '../progressStore';

const pdf = { kind: 'pdf' as const, page: 4, percent: 0.3 };

beforeEach(() => localStorage.clear());

it('prefers the newer of local and server progress', () => {
  const server = {
    bookId: 'b',
    locator: pdf,
    percent: 0.3,
    updatedAt: '2026-03-01T00:00:00.000Z',
  };
  writeLocalProgress(
    'b',
    { ...pdf, page: 7, percent: 0.6 },
    new Date('2026-02-01T00:00:00Z').getTime(),
  );
  expect(resolveInitialLocator(server, readLocalProgress('b')))
    .toEqual({ ...pdf, page: 4, percent: 0.3 });

  writeLocalProgress(
    'b',
    { ...pdf, page: 7, percent: 0.6 },
    new Date('2026-04-01T00:00:00Z').getTime(),
  );
  expect(resolveInitialLocator(server, readLocalProgress('b')))
    .toEqual({ ...pdf, page: 7, percent: 0.6 });
});

it('falls back to local when the server has no progress', () => {
  writeLocalProgress('b', pdf, Date.now());
  expect(resolveInitialLocator(null, readLocalProgress('b'))).toEqual(pdf);
});
