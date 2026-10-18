import { beforeEach, expect, it } from 'vitest';
import {
  PROGRESS_KEY_PREFIX,
  clearReaderProgressCache,
  readLocalProgress,
  resolveInitialLocator,
  writeLocalProgress,
} from '../progressStore';

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
    'user-a',
    'b',
    { ...pdf, page: 7, percent: 0.6 },
    new Date('2026-02-01T00:00:00Z').getTime(),
  );
  expect(resolveInitialLocator(server, readLocalProgress('user-a', 'b')))
    .toEqual({ ...pdf, page: 4, percent: 0.3 });

  writeLocalProgress(
    'user-a',
    'b',
    { ...pdf, page: 7, percent: 0.6 },
    new Date('2026-04-01T00:00:00Z').getTime(),
  );
  expect(resolveInitialLocator(server, readLocalProgress('user-a', 'b')))
    .toEqual({ ...pdf, page: 7, percent: 0.6 });
});

it('falls back to local when the server has no progress', () => {
  writeLocalProgress('user-a', 'b', pdf, Date.now());
  expect(resolveInitialLocator(null, readLocalProgress('user-a', 'b'))).toEqual(pdf);
});

it('keeps one cached position per account for the same book', () => {
  const position = { ...pdf, page: 7, percent: 0.6 };
  writeLocalProgress('user-a', 'b', position, Date.now());

  expect(readLocalProgress('user-a', 'b')).toMatchObject({ locator: position });
  // A second account on the same browser must not inherit A's position.
  expect(readLocalProgress('user-b', 'b')).toBeNull();
});

it('clears every account and book while keeping unrelated storage', () => {
  const position = { ...pdf, page: 7, percent: 0.6 };
  writeLocalProgress('user-a', 'b', position, Date.now());
  writeLocalProgress('user-b', 'c', position, Date.now());
  localStorage.setItem('bookr.reader.settings', '{"theme":"paper"}');

  clearReaderProgressCache();

  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem('bookr.reader.settings')).toBe('{"theme":"paper"}');
  expect([...Array(localStorage.length).keys()]
    .map((index) => localStorage.key(index))
    .filter((key) => key?.startsWith(PROGRESS_KEY_PREFIX))).toEqual([]);
  expect(readLocalProgress('user-a', 'b')).toBeNull();
  expect(readLocalProgress('user-b', 'c')).toBeNull();
});
