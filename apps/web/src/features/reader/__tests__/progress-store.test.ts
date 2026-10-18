import { beforeEach, expect, it } from 'vitest';
import {
  PROGRESS_KEY_PREFIX,
  clearReaderProgressCache,
  readLocalProgress,
  writeLegacyProgress,
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

it('uses the row a concurrent sync wrote during the legacy migration', async () => {
  const legacyKey = `${PROGRESS_KEY_PREFIX}user-a.b`;
  localStorage.setItem(legacyKey, JSON.stringify({ locator: pdf, savedAt: 1 }));

  const pulled = { ...pdf, page: 9, percent: 0.8 };
  const pulledAt = Date.parse('2026-05-01T00:00:00.000Z');
  repo.seedProgress('user-a', 'b', pulled, pulledAt);

  // The first read misses the row, then a pull writes it before the import.
  const progressFor = repo.progressFor.bind(repo);
  let reads = 0;
  repo.progressFor = async (userId, bookId) => {
    reads += 1;
    return reads === 1 ? null : progressFor(userId, bookId);
  };

  const resolved = await readLocalProgress(repo, 'user-a', 'b');

  expect(resolved?.locator).toEqual(pulled);
  expect(resolved?.savedAt).toBe(pulledAt);
  expect(localStorage.getItem(legacyKey)).toBeNull();
});

it('writes the synchronous buffer under the per-account key', () => {
  writeLegacyProgress('user-a', 'b', pdf, 1_700_000_000_123);

  expect(JSON.parse(localStorage.getItem(`${PROGRESS_KEY_PREFIX}user-a.b`) ?? 'null')).toEqual({
    locator: pdf,
    savedAt: 1_700_000_000_123,
  });
});

it('uses a newer legacy buffer and queues the buffered position for sync', async () => {
  const legacyKey = `${PROGRESS_KEY_PREFIX}user-a.b`;
  const storedAt = 1_700_000_000_000;
  const bufferedAt = storedAt + 4_000;
  const buffered = { ...pdf, page: 8, percent: 0.9 };
  repo.seedProgress('user-a', 'b', { ...pdf, page: 2, percent: 0.2 }, storedAt);
  localStorage.setItem(legacyKey, JSON.stringify({ locator: buffered, savedAt: bufferedAt }));

  const resolved = await readLocalProgress(repo, 'user-a', 'b');

  expect(resolved).toEqual({ locator: buffered, savedAt: bufferedAt });
  expect(localStorage.getItem(legacyKey)).toBeNull();

  const stored = await repo.progressFor('user-a', 'b');
  expect(stored?.locator).toEqual(buffered);
  expect(stored?.clientUpdatedAt).toBe(new Date(bufferedAt).toISOString());
  expect(stored?.dirty).toBe(true);
  // The buffer held the last position before the page died; that position must
  // reach the server like any other page turn.
  expect(await repo.pendingCount('user-a')).toBe(1);
  expect(repo.outbox[0]).toMatchObject({
    entityType: 'reading_progress',
    entityId: 'b',
    op: 'upsert',
    payload: { bookId: 'b', locator: buffered },
    clientUpdatedAt: new Date(bufferedAt).toISOString(),
  });
});

it('keeps the Dexie row aligned by the first pull over an older legacy buffer', async () => {
  const legacyKey = `${PROGRESS_KEY_PREFIX}user-a.b`;
  const pulled = { ...pdf, page: 9, percent: 0.8 };
  const pulledAt = Date.parse('2026-05-01T00:00:00.000Z');
  repo.seedProgress('user-a', 'b', pulled, pulledAt);
  localStorage.setItem(
    legacyKey,
    JSON.stringify({ locator: { ...pdf, page: 3 }, savedAt: pulledAt - 10_000 }),
  );

  const resolved = await readLocalProgress(repo, 'user-a', 'b');

  expect(resolved).toEqual({ locator: pulled, savedAt: pulledAt });
  expect(localStorage.getItem(legacyKey)).toBeNull();

  const stored = await repo.progressFor('user-a', 'b');
  expect(stored?.locator).toEqual(pulled);
  expect(stored?.dirty).toBe(false);
  expect(await repo.pendingCount('user-a')).toBe(0);
});

it('clears every account and book while keeping unrelated storage', () => {
  localStorage.setItem(`${PROGRESS_KEY_PREFIX}user-a.b`, JSON.stringify({ locator: pdf, savedAt: 1 }));
  localStorage.setItem(`${PROGRESS_KEY_PREFIX}user-b.c`, JSON.stringify({ locator: pdf, savedAt: 1 }));
  localStorage.setItem('bookr.reader.settings', '{"theme":"paper"}');

  clearReaderProgressCache();

  expect(localStorage.length).toBe(1);
  expect(localStorage.getItem('bookr.reader.settings')).toBe('{"theme":"paper"}');
});
