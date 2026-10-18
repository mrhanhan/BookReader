import { beforeEach, expect, it } from 'vitest';
import {
  PROGRESS_KEY_PREFIX,
  clearReaderProgressCache,
  readLocalProgress,
  writeLocalProgress,
} from '../progressStore';
import { createMemoryRepository } from '../../../../test/memory-repository';

const pdf = { kind: 'pdf' as const, page: 4, percent: 0.3 };

let repo: ReturnType<typeof createMemoryRepository>;

beforeEach(() => {
  localStorage.clear();
  repo = createMemoryRepository();
});

it('reads the position stored in the repository', async () => {
  const position = { ...pdf, page: 7, percent: 0.6 };
  repo.seedProgress('user-a', 'b', position, Date.now());

  expect((await readLocalProgress(repo, 'user-a', 'b'))?.locator).toEqual(position);
});

it('migrates a legacy localStorage position once without queueing a sync', async () => {
  const legacyKey = `${PROGRESS_KEY_PREFIX}user-a.b`;
  localStorage.setItem(
    legacyKey,
    JSON.stringify({ locator: { ...pdf, page: 7 }, savedAt: 1_700_000_000_000 }),
  );

  const migrated = await readLocalProgress(repo, 'user-a', 'b');

  expect(migrated?.locator).toEqual({ ...pdf, page: 7 });
  expect(localStorage.getItem(legacyKey)).toBeNull();
  const stored = await repo.progressFor('user-a', 'b');
  expect(stored?.locator).toEqual({ ...pdf, page: 7 });
  expect(stored?.dirty).toBe(false);
  expect(await repo.pendingCount('user-a')).toBe(0);

  // A second read comes from Dexie, not the removed legacy entry.
  expect((await readLocalProgress(repo, 'user-a', 'b'))?.locator).toEqual({
    ...pdf,
    page: 7,
  });
  expect(await repo.pendingCount('user-a')).toBe(0);
});

it('writes locally and queues the change for sync', async () => {
  expect(await writeLocalProgress(repo, 'user-a', 'b', pdf, Date.now())).toBe(true);

  expect((await repo.progressFor('user-a', 'b'))?.locator).toEqual(pdf);
  expect(await repo.pendingCount('user-a')).toBe(1);
});

it('reports a failed local write without throwing', async () => {
  repo.saveProgress = async () => {
    throw new Error('quota exceeded');
  };

  expect(await writeLocalProgress(repo, 'user-a', 'b', pdf, Date.now())).toBe(false);
});

it('keeps one cached position per account for the same book', async () => {
  expect(await writeLocalProgress(repo, 'user-a', 'b', { ...pdf, page: 7 }, Date.now())).toBe(true);

  expect((await readLocalProgress(repo, 'user-a', 'b'))?.locator).toMatchObject({ page: 7 });
  // A second account on the same browser must not inherit A's position.
  expect(await readLocalProgress(repo, 'user-b', 'b')).toBeNull();
});

it('clears every account and book while keeping unrelated storage', () => {
  localStorage.setItem(`${PROGRESS_KEY_PREFIX}user-a.b`, JSON.stringify({ locator: pdf, savedAt: 1 }));
  localStorage.setItem(`${PROGRESS_KEY_PREFIX}user-b.c`, JSON.stringify({ locator: pdf, savedAt: 1 }));
  localStorage.setItem('bookr.reader.settings', '{"theme":"paper"}');

  clearReaderProgressCache();

  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem('bookr.reader.settings')).toBe('{"theme":"paper"}');
});
