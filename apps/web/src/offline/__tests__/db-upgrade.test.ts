import Dexie from 'dexie';
import { describe, expect, it } from 'vitest';
import { createSyncDb } from '../../sync/db';

let counter = 0;

function uniqueName(): string {
  counter += 1;
  return `bookr-upgrade-test-${counter}`;
}

describe('offlineBooks schema upgrade', () => {
  it('recreates the cache table with the compound key and keeps the other tables', async () => {
    const name = uniqueName();

    // Write a database with the exact version 1 schema shipped before Task 12.
    const legacy = new Dexie(name);
    legacy.version(1).stores({
      progress: '[userId+bookId], userId, bookId, updatedAt',
      annotations: 'id, userId, bookId, [userId+bookId], dirty',
      bookmarks: 'id, userId, bookId, [userId+bookId], dirty',
      settings: 'userId',
      outbox: 'id, userId, [userId+nextAttemptAt]',
      meta: 'key',
      offlineBooks: 'bookId, userId, pinned, lastReadAt',
      shelf: 'id, userId, updatedAt',
    });
    await legacy.open();
    await legacy.table('offlineBooks').put({
      bookId: 'book-1',
      userId: 'user-1',
      pinned: true,
      lastReadAt: 1,
      cachedAt: 1,
      bytes: 10,
    });
    legacy.close();

    const upgraded = createSyncDb(name);
    await upgraded.open();
    try {
      // The primary key cannot be changed in place, so old cache rows are
      // dropped by design; cached files remain on disk and are recached later.
      expect(await upgraded.offlineBooks.count()).toBe(0);

      await upgraded.offlineBooks.bulkPut([
        { bookId: 'book-1', userId: 'user-1', pinned: true, lastReadAt: 1, cachedAt: 1, bytes: 10 },
        { bookId: 'book-1', userId: 'user-2', pinned: false, lastReadAt: 2, cachedAt: 2, bytes: 20 },
      ]);

      expect(await upgraded.offlineBooks.count()).toBe(2);
      expect((await upgraded.offlineBooks.get(['user-2', 'book-1']))?.bytes).toBe(20);

      // Unrelated tables from version 1 still work.
      await upgraded.annotations.put({
        id: 'annotation-1',
        bookId: 'book-1',
        userId: 'user-1',
        type: 'highlight',
        color: 'yellow',
        locator: { kind: 'pdf', page: 1, percent: 0.1 },
        selectedText: '文字',
        noteText: null,
        tags: [],
        revision: 1,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
        clientUpdatedAt: '2026-01-01T00:00:00.000Z',
        dirty: true,
      });
      expect(await upgraded.annotations.count()).toBe(1);
    } finally {
      upgraded.close();
      await Dexie.delete(name);
    }
  });
});
