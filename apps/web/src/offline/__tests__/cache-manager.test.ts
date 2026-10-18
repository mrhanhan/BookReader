import type { Locator } from '@bookr/shared';
import { afterEach, beforeEach, describe, expect, it, vi, type Mock } from 'vitest';
import { createSyncDb, type BookrDb } from '../../sync/db';
import { createCacheManager, OFFLINE_RECENT_LIMIT, type CacheManager } from '../cacheManager';
import { cacheKey, createMemoryStore, type CacheKind, type CachedFileStore } from '../fileStore';

const USER = 'user-reader';
const OTHER_USER = 'user-other';
const T = '2026-01-01T00:00:00.000Z';

const locator: Locator = { kind: 'pdf', page: 3, percent: 0.25 };

const originalCreateObjectURL = URL.createObjectURL;
const originalRevokeObjectURL = URL.revokeObjectURL;
const hadOwnCreateObjectURL = Object.prototype.hasOwnProperty.call(URL, 'createObjectURL');
const hadOwnRevokeObjectURL = Object.prototype.hasOwnProperty.call(URL, 'revokeObjectURL');

let counter = 0;
let db: BookrDb;
let store: CachedFileStore;
let manager: CacheManager;
let clock: number;
let urlCounter: number;
let payloads: Map<string, Blob>;
let createObjectUrl: Mock<(blob: Blob) => string>;
let revokeObjectUrl: Mock<(url: string) => void>;

function urlOf(input: RequestInfo | URL): string {
  if (typeof input === 'string') return input;
  if (input instanceof URL) return input.href;
  return input.url;
}

function responseWith(payload: Blob | null): Response {
  return {
    ok: payload !== null,
    status: payload === null ? 404 : 200,
    blob: async () => payload ?? new Blob(),
  } as unknown as Response;
}

async function cacheBook(bookId: string, kind: CacheKind = 'book', size = 4): Promise<void> {
  const url = `https://files.test/${bookId}/${kind}`;
  payloads.set(url, new Blob(['x'.repeat(size)]));
  clock += 1;
  await manager.cacheFromUrl(USER, bookId, kind, url);
}

async function seedReadingData(): Promise<void> {
  await db.annotations.put({
    id: 'annotation-1',
    bookId: 'book-0',
    userId: USER,
    type: 'highlight',
    color: 'yellow',
    locator,
    selectedText: '一段文字',
    noteText: null,
    tags: [],
    revision: 1,
    createdAt: T,
    updatedAt: T,
    clientUpdatedAt: T,
    dirty: true,
  });
  await db.bookmarks.put({
    id: 'bookmark-1',
    bookId: 'book-0',
    userId: USER,
    locator,
    label: '书签',
    createdAt: T,
    updatedAt: T,
    clientUpdatedAt: T,
    dirty: true,
  });
  await db.progress.put({
    userId: USER,
    bookId: 'book-0',
    locator,
    percent: locator.percent,
    updatedAt: T,
    clientUpdatedAt: T,
    dirty: true,
  });
  await db.outbox.put({
    id: 'outbox-1',
    userId: USER,
    entityType: 'annotation',
    entityId: 'annotation-1',
    op: 'upsert',
    payload: { bookId: 'book-0' },
    clientUpdatedAt: T,
    attempts: 0,
    nextAttemptAt: 0,
  });
}

async function readingDataCounts(): Promise<[number, number, number, number]> {
  return Promise.all([
    db.annotations.count(),
    db.bookmarks.count(),
    db.progress.count(),
    db.outbox.count(),
  ]);
}

beforeEach(() => {
  counter += 1;
  clock = 1_000;
  urlCounter = 0;
  payloads = new Map();
  db = createSyncDb(`bookr-cache-manager-test-${counter}`);
  store = createMemoryStore();
  createObjectUrl = vi.fn((_blob: Blob) => {
    urlCounter += 1;
    return `blob:bookr-${urlCounter}`;
  });
  revokeObjectUrl = vi.fn((_url: string) => undefined);
  URL.createObjectURL = createObjectUrl;
  URL.revokeObjectURL = revokeObjectUrl;
  manager = createCacheManager({
    store,
    db,
    now: () => clock,
    fetchImpl: vi.fn(async (input: RequestInfo | URL) => {
      const payload = payloads.get(urlOf(input)) ?? null;
      return responseWith(payload);
    }),
  });
});

afterEach(async () => {
  manager.revokeUrls();
  if (hadOwnCreateObjectURL) {
    URL.createObjectURL = originalCreateObjectURL;
  } else {
    Reflect.deleteProperty(URL, 'createObjectURL');
  }
  if (hadOwnRevokeObjectURL) {
    URL.revokeObjectURL = originalRevokeObjectURL;
  } else {
    Reflect.deleteProperty(URL, 'revokeObjectURL');
  }
  await db.delete();
});

describe('CacheManager LRU', () => {
  it('evicts the sixth unpinned book by last-read time', async () => {
    await seedReadingData();
    const before = await readingDataCounts();
    for (let index = 0; index < OFFLINE_RECENT_LIMIT + 1; index += 1) {
      await cacheBook(`book-${index}`);
    }
    // The reflow file is cached later but must still be evicted with the book.
    await cacheBook('book-0', 'reflow');
    const objectUrl = await manager.cachedUrl(USER, 'book-0', 'book');

    const evicted = await manager.enforceLru(USER);

    expect(evicted).toEqual(['book-0']);
    expect(await store.has(cacheKey(USER, 'book-0', 'book'))).toBe(false);
    expect(await store.has(cacheKey(USER, 'book-0', 'reflow'))).toBe(false);
    expect(revokeObjectUrl).toHaveBeenCalledWith(objectUrl);
    expect(await db.offlineBooks.get([USER, 'book-0'])).toBeUndefined();
    expect(await db.offlineBooks.count()).toBe(OFFLINE_RECENT_LIMIT);
    expect((await db.offlineBooks.get([USER, 'book-1']))?.bookId).toBe('book-1');
    // Eviction is cache-only: everything the reader wrote is still there.
    expect(await readingDataCounts()).toEqual(before);
  });

  it('drops an unpinned placeholder instead of letting it use an LRU slot', async () => {
    for (let index = 0; index < OFFLINE_RECENT_LIMIT; index += 1) {
      await cacheBook(`book-${index}`);
    }

    clock += 1;
    await manager.pin(USER, 'book-new');
    // The zero-byte placeholder must not compete with the five real books.
    expect(await manager.enforceLru(USER)).toEqual([]);

    await manager.unpin(USER, 'book-new');

    expect(await db.offlineBooks.get([USER, 'book-new'])).toBeUndefined();
    expect(await manager.enforceLru(USER)).toEqual([]);
    for (let index = 0; index < OFFLINE_RECENT_LIMIT; index += 1) {
      expect(await store.has(cacheKey(USER, `book-${index}`, 'book'))).toBe(true);
    }
  });

  it('evicts each user independently for the same book id', async () => {
    for (let index = 0; index < OFFLINE_RECENT_LIMIT + 1; index += 1) {
      await cacheBook(`book-${index}`);
    }
    clock += 1;
    const otherUrl = 'https://files.test/other-book-0';
    payloads.set(otherUrl, new Blob(['other']));
    await manager.cacheFromUrl(OTHER_USER, 'book-0', 'book', otherUrl);

    const evicted = await manager.enforceLru(USER);

    expect(evicted).toEqual(['book-0']);
    expect(await db.offlineBooks.get([USER, 'book-0'])).toBeUndefined();
    expect((await db.offlineBooks.get([OTHER_USER, 'book-0']))?.userId).toBe(OTHER_USER);
    expect(await store.has(cacheKey(OTHER_USER, 'book-0', 'book'))).toBe(true);
  });

  it('never evicts a pinned book or the book being read', async () => {
    for (let index = 0; index < 8; index += 1) {
      await cacheBook(`book-${index}`);
    }
    await manager.pin(USER, 'book-0');

    const evicted = await manager.enforceLru(USER, 'book-1');

    expect(evicted).toEqual(['book-2']);
    expect(await store.has(cacheKey(USER, 'book-0', 'book'))).toBe(true);
    expect(await store.has(cacheKey(USER, 'book-1', 'book'))).toBe(true);
    expect(await store.has(cacheKey(USER, 'book-2', 'book'))).toBe(false);
    expect(await db.offlineBooks.get([USER, 'book-2'])).toBeUndefined();

    const remaining = (await db.offlineBooks.toArray()).map((row) => row.bookId).sort();
    expect(remaining).toEqual([
      'book-0',
      'book-1',
      'book-3',
      'book-4',
      'book-5',
      'book-6',
      'book-7',
    ]);
  });

  it('touching a book refreshes its place in the LRU order', async () => {
    for (let index = 0; index < OFFLINE_RECENT_LIMIT + 1; index += 1) {
      await cacheBook(`book-${index}`);
    }
    clock = 99_999;
    await manager.touch(USER, 'book-0');

    const evicted = await manager.enforceLru(USER);

    expect(evicted).toEqual(['book-1']);
    expect(await store.has(cacheKey(USER, 'book-0', 'book'))).toBe(true);
  });

  it('keeps the pinned count outside the recent window', async () => {
    for (let index = 0; index < OFFLINE_RECENT_LIMIT + 4; index += 1) {
      await cacheBook(`book-${index}`);
    }
    await manager.pin(USER, 'book-0');
    await manager.pin(USER, 'book-1');

    const evicted = await manager.enforceLru(USER);

    // Seven unpinned candidates compete for five slots; the two oldest go.
    // Pinned rows sit outside the recent window.
    expect(evicted).toEqual(['book-2', 'book-3']);
    expect(await db.offlineBooks.count()).toBe(OFFLINE_RECENT_LIMIT + 2);
  });
});

describe('CacheManager eviction safety', () => {
  it('clearing the cache leaves annotations, bookmarks, progress and outbox intact', async () => {
    await seedReadingData();
    const before = await readingDataCounts();
    await cacheBook('book-0');
    await cacheBook('book-1');
    await manager.pin(USER, 'book-1');

    const cleared = await manager.clearUnpinned(USER);

    expect(cleared).toEqual(['book-0']);
    expect(await store.has(cacheKey(USER, 'book-0', 'book'))).toBe(false);
    expect(await db.offlineBooks.get([USER, 'book-0'])).toBeUndefined();
    expect((await db.offlineBooks.get([USER, 'book-1']))?.pinned).toBe(true);
    expect(await readingDataCounts()).toEqual(before);
    expect(before).toEqual([1, 1, 1, 1]);
  });

  it('removing one book deletes only its files and cache row', async () => {
    await seedReadingData();
    const before = await readingDataCounts();
    expect(before).toEqual([1, 1, 1, 1]);
    await cacheBook('book-0');
    await cacheBook('book-1');

    await manager.remove(USER, 'book-0');

    expect(await store.has(cacheKey(USER, 'book-0', 'book'))).toBe(false);
    expect(await store.has(cacheKey(USER, 'book-0', 'reflow'))).toBe(false);
    expect(await store.has(cacheKey(USER, 'book-1', 'book'))).toBe(true);
    expect(await db.offlineBooks.get([USER, 'book-0'])).toBeUndefined();
    expect(await db.offlineBooks.get([USER, 'book-1'])).toBeDefined();
    expect(await readingDataCounts()).toEqual(before);
  });

  it('clearUnpinned keeps the requested book even when it is unpinned', async () => {
    await cacheBook('book-0');
    await cacheBook('book-1');
    await cacheBook('book-2');

    const cleared = await manager.clearUnpinned(USER, 'book-1');

    expect(cleared).toEqual(['book-0', 'book-2']);
    expect(await db.offlineBooks.get([USER, 'book-1'])).toBeDefined();
    expect(await store.has(cacheKey(USER, 'book-1', 'book'))).toBe(true);
    expect(await store.has(cacheKey(USER, 'book-0', 'book'))).toBe(false);
    expect(await store.has(cacheKey(USER, 'book-2', 'book'))).toBe(false);
  });

  it('keeps cache rows independent for two users with the same book id', async () => {
    const sharedUrl = 'https://files.test/shared';
    payloads.set(sharedUrl, new Blob(['1234']));
    clock += 1;
    await manager.cacheFromUrl(USER, 'book-1', 'book', sharedUrl);
    clock += 1;
    await manager.cacheFromUrl(OTHER_USER, 'book-1', 'book', sharedUrl);

    expect(await db.offlineBooks.count()).toBe(2);
    await manager.pin(USER, 'book-1');
    expect(await manager.isPinned(USER, 'book-1')).toBe(true);
    expect(await manager.isPinned(OTHER_USER, 'book-1')).toBe(false);

    await manager.remove(USER, 'book-1');

    expect(await store.has(cacheKey(USER, 'book-1', 'book'))).toBe(false);
    expect(await store.has(cacheKey(OTHER_USER, 'book-1', 'book'))).toBe(true);
    expect((await db.offlineBooks.get([OTHER_USER, 'book-1']))?.userId).toBe(OTHER_USER);
  });

  it('never clears another user’s files', async () => {
    await cacheBook('book-0');
    clock += 1;
    const otherUrl = 'https://files.test/other/book';
    payloads.set(otherUrl, new Blob(['other']));
    await manager.cacheFromUrl(OTHER_USER, 'book-9', 'book', otherUrl);

    const cleared = await manager.clearUnpinned(USER);

    expect(cleared).toEqual(['book-0']);
    expect(await store.has(cacheKey(OTHER_USER, 'book-9', 'book'))).toBe(true);
    expect((await db.offlineBooks.get([OTHER_USER, 'book-9']))?.userId).toBe(OTHER_USER);
  });
});

describe('CacheManager bytes and usage', () => {
  it('sums book and reflow bytes per book', async () => {
    payloads.set('https://files.test/book-1/book', new Blob(['1234567890']));
    payloads.set('https://files.test/book-1/reflow', new Blob(['12345']));

    expect(
      await manager.cacheFromUrl(USER, 'book-1', 'book', 'https://files.test/book-1/book'),
    ).toBe(10);
    clock += 1;
    expect(
      await manager.cacheFromUrl(USER, 'book-1', 'reflow', 'https://files.test/book-1/reflow'),
    ).toBe(5);

    expect((await db.offlineBooks.get([USER, 'book-1']))?.bytes).toBe(15);
    expect((await manager.usage(USER)).bytes).toBe(15);
  });

  it('accumulates bytes when book and reflow are cached in parallel', async () => {
    const bookUrl = 'https://files.test/parallel/book';
    const reflowUrl = 'https://files.test/parallel/reflow';
    payloads.set(bookUrl, new Blob(['1234567890']));
    payloads.set(reflowUrl, new Blob(['12345']));
    clock += 1;

    const sizes = await Promise.all([
      manager.cacheFromUrl(USER, 'book-1', 'book', bookUrl),
      manager.cacheFromUrl(USER, 'book-1', 'reflow', reflowUrl),
    ]);

    expect(sizes.sort((left, right) => left - right)).toEqual([5, 10]);
    expect((await db.offlineBooks.get([USER, 'book-1']))?.bytes).toBe(15);
    expect((await manager.usage(USER)).bytes).toBe(15);
  });

  it('keeps a pin that races the first download', async () => {
    const url = 'https://files.test/raced/book';
    payloads.set(url, new Blob(['1234']));

    await Promise.all([
      manager.cacheFromUrl(USER, 'book-1', 'book', url),
      manager.pin(USER, 'book-1'),
    ]);

    expect(await db.offlineBooks.get([USER, 'book-1'])).toMatchObject({
      pinned: true,
      bytes: 4,
    });
  });

  it('replaces the old size when a file is cached again', async () => {
    payloads.set('https://files.test/book-1/book', new Blob(['1234567890']));
    await manager.cacheFromUrl(USER, 'book-1', 'book', 'https://files.test/book-1/book');
    payloads.set('https://files.test/book-1/book', new Blob(['123']));

    clock += 1;
    expect(
      await manager.cacheFromUrl(USER, 'book-1', 'book', 'https://files.test/book-1/book'),
    ).toBe(3);

    expect((await db.offlineBooks.get([USER, 'book-1']))?.bytes).toBe(3);
    expect((await manager.usage(USER)).bytes).toBe(3);
  });

  it('keeps bytes accurate when the same file is downloaded twice at once', async () => {
    const url = 'https://files.test/concurrent/book';
    payloads.set(url, new Blob(['1234567890']));
    await manager.cacheFromUrl(USER, 'book-1', 'book', url);
    expect((await db.offlineBooks.get([USER, 'book-1']))?.bytes).toBe(10);

    payloads.set(url, new Blob(['12345']));
    clock += 1;
    await Promise.all([
      manager.cacheFromUrl(USER, 'book-1', 'book', url),
      manager.cacheFromUrl(USER, 'book-1', 'book', url),
    ]);

    expect((await store.get(cacheKey(USER, 'book-1', 'book')))?.size).toBe(5);
    expect((await db.offlineBooks.get([USER, 'book-1']))?.bytes).toBe(5);
  });

  it('uses the existing file size when the cache row is missing', async () => {
    const url = 'https://files.test/orphan/book';
    // Simulate a schema rebuild that dropped the row but left the file behind.
    await store.put(cacheKey(USER, 'book-1', 'book'), new Blob(['1234']));
    payloads.set(url, new Blob(['abcd']));

    await manager.cacheFromUrl(USER, 'book-1', 'book', url);

    expect((await db.offlineBooks.get([USER, 'book-1']))?.bytes).toBe(4);
  });

  it('reports cached books and a null quota when storage is unavailable', async () => {
    await cacheBook('book-0');
    clock += 1;
    await manager.touch(USER, 'book-0');

    const usage = await manager.usage(USER);

    expect(usage.books.map((row) => row.bookId)).toEqual(['book-0']);
    expect(usage.quota).toBeNull();
  });

  it('reads the quota from navigator.storage.estimate', async () => {
    const estimate = vi.fn(async () => ({ quota: 2048, usage: 0 }));
    Object.defineProperty(navigator, 'storage', { configurable: true, value: { estimate } });

    try {
      expect((await manager.usage(USER)).quota).toBe(2048);
      expect(estimate).toHaveBeenCalledTimes(1);
    } finally {
      Reflect.deleteProperty(navigator, 'storage');
    }
  });
});

describe('CacheManager object URLs', () => {
  it('returns a reusable object URL for a cached file', async () => {
    await cacheBook('book-0');

    const first = await manager.cachedUrl(USER, 'book-0', 'book');
    const second = await manager.cachedUrl(USER, 'book-0', 'book');

    expect(first).toBe('blob:bookr-1');
    expect(second).toBe(first);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
    expect(await manager.cachedUrl(USER, 'missing', 'book')).toBeNull();

    await manager.remove(USER, 'book-0');
    expect(revokeObjectUrl).toHaveBeenCalledWith(first);
  });

  it('shares one in-flight object URL between concurrent callers', async () => {
    await cacheBook('book-0');

    const [first, second] = await Promise.all([
      manager.cachedUrl(USER, 'book-0', 'book'),
      manager.cachedUrl(USER, 'book-0', 'book'),
    ]);

    expect(first).not.toBeNull();
    expect(second).toBe(first);
    expect(createObjectUrl).toHaveBeenCalledTimes(1);
  });

  it('revokes every object URL from revokeUrls', async () => {
    await cacheBook('book-0');
    await cacheBook('book-1');
    const first = await manager.cachedUrl(USER, 'book-0', 'book');
    const second = await manager.cachedUrl(USER, 'book-1', 'book');

    manager.revokeUrls();

    expect(revokeObjectUrl).toHaveBeenCalledTimes(2);
    expect(revokeObjectUrl).toHaveBeenCalledWith(first);
    expect(revokeObjectUrl).toHaveBeenCalledWith(second);
    expect(await manager.cachedUrl(USER, 'book-0', 'book')).toBe('blob:bookr-3');
  });

  it('invalidates the object URL when a file is cached again', async () => {
    await cacheBook('book-0');
    const first = await manager.cachedUrl(USER, 'book-0', 'book');

    await cacheBook('book-0');
    const second = await manager.cachedUrl(USER, 'book-0', 'book');

    expect(second).not.toBe(first);
    expect(revokeObjectUrl).toHaveBeenCalledWith(first);
  });
});

describe('CacheManager pinning and downloads', () => {
  it('pins, unpins and reports the pin state', async () => {
    expect(await manager.isPinned(USER, 'book-1')).toBe(false);

    await manager.pin(USER, 'book-1');
    expect(await manager.isPinned(USER, 'book-1')).toBe(true);
    expect((await db.offlineBooks.get([USER, 'book-1']))?.pinned).toBe(true);

    await manager.unpin(USER, 'book-1');
    expect(await manager.isPinned(USER, 'book-1')).toBe(false);
  });

  it('keeps a book pinned when its file is cached again', async () => {
    await manager.pin(USER, 'book-1');
    await cacheBook('book-1');

    const row = await db.offlineBooks.get([USER, 'book-1']);
    expect(row).toMatchObject({ pinned: true, bytes: 4 });
  });

  it('rejects non-2xx downloads without writing a file or row', async () => {
    await expect(
      manager.cacheFromUrl(USER, 'book-1', 'book', 'https://files.test/missing'),
    ).rejects.toThrow(/HTTP 404/);

    expect(await store.has(cacheKey(USER, 'book-1', 'book'))).toBe(false);
    expect(await db.offlineBooks.get([USER, 'book-1'])).toBeUndefined();
  });
});
