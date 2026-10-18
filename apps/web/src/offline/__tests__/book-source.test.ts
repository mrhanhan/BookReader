import { afterEach, expect, it, vi } from 'vitest';
import { createSyncDb } from '../../sync/db';
import type { BookrDb } from '../../sync/db';
import {
  CACHE_REFRESH_AFTER_MS,
  OfflineUnavailableError,
  OFFLINE_UNAVAILABLE_MESSAGE,
  resolveBookSource,
} from '../bookSource';
import { createCacheManager } from '../cacheManager';
import type { CacheManager } from '../cacheManager';
import { cacheKey, createMemoryStore } from '../fileStore';

const USER = 'user-reader';
const BOOK = 'book-1';

let sequence = 0;
const openDbs: BookrDb[] = [];

afterEach(() => {
  for (const db of openDbs.splice(0)) db.close();
});

function setup() {
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL): Promise<Response> =>
      new Response(`bytes for ${String(input)}`),
  );
  const db = createSyncDb(`book-source-${++sequence}`);
  openDbs.push(db);
  const store = createMemoryStore();
  const cache = createCacheManager({
    store,
    db,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { cache, db, fetchImpl, store };
}

it('uses the signed URL when online and caches the file in the background', async () => {
  const { cache, fetchImpl } = setup();
  // A pinned book refreshes its downloaded copy on every open.
  await cache.pin(USER, BOOK);

  const fetchFile = vi.fn(async () => ({ url: 'https://files.test/signed.pdf' }));
  const fetchReflow = vi.fn(async () => ({ url: 'https://files.test/pack.bookr.json' }));

  const resolved = await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: true,
    fetchFile,
    fetchReflow,
  });

  expect(resolved).toEqual({
    fileUrl: 'https://files.test/signed.pdf',
    reflowUrl: 'https://files.test/pack.bookr.json',
    offline: false,
  });

  // The refresh runs in the background, so reading never waits on the download.
  await vi.waitFor(() => {
    expect(fetchImpl).toHaveBeenCalledWith('https://files.test/signed.pdf');
  });
  await vi.waitFor(() => {
    expect(fetchImpl).toHaveBeenCalledWith('https://files.test/pack.bookr.json');
  });
  await vi.waitFor(async () => {
    expect(await cache.cachedUrl(USER, BOOK, 'book')).not.toBeNull();
  });
  await vi.waitFor(async () => {
    expect(await cache.cachedUrl(USER, BOOK, 'reflow')).not.toBeNull();
  });
});

it('caches a book on its first online open and counts it among the recent five', async () => {
  const { cache, db, fetchImpl } = setup();

  const resolved = await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile: async () => ({ url: 'https://files.test/signed.epub' }),
    fetchReflow: async () => null,
  });

  expect(resolved.offline).toBe(false);
  await vi.waitFor(async () => {
    expect(await db.offlineBooks.get([USER, BOOK])).toMatchObject({ pinned: false });
  });
  expect(fetchImpl).toHaveBeenCalledWith('https://files.test/signed.epub');
  const row = await db.offlineBooks.get([USER, BOOK]);
  expect(row?.bytes).toBeGreaterThan(0);
  expect(row?.lastReadAt).toBeGreaterThan(0);
  expect(await cache.cachedUrl(USER, BOOK, 'book')).not.toBeNull();
});

it('caches the reflow pack alongside the book when one exists', async () => {
  const { cache, db, fetchImpl } = setup();

  await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: true,
    fetchFile: async () => ({ url: 'https://files.test/signed.pdf' }),
    fetchReflow: async () => ({ url: 'https://files.test/pack.bookr.json' }),
  });

  await vi.waitFor(async () => {
    expect(await cache.cachedUrl(USER, BOOK, 'book')).not.toBeNull();
    expect(await cache.cachedUrl(USER, BOOK, 'reflow')).not.toBeNull();
  });
  expect(fetchImpl).toHaveBeenCalledWith('https://files.test/pack.bookr.json');
});

it('keeps reading when the automatic download fails', async () => {
  const db = createSyncDb(`book-source-${++sequence}`);
  openDbs.push(db);
  const cache = createCacheManager({
    store: createMemoryStore(),
    db,
    fetchImpl: vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
  });

  const resolved = await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile: async () => ({ url: 'https://files.test/signed.epub' }),
    fetchReflow: async () => null,
  });

  expect(resolved).toEqual({
    fileUrl: 'https://files.test/signed.epub',
    reflowUrl: null,
    offline: false,
  });
  await new Promise((resolve) => setTimeout(resolve, 20));
  expect(await db.offlineBooks.get([USER, BOOK])).toBeUndefined();
});

it('falls back to the cached blob when the network fails', async () => {
  const { cache } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.pdf');
  await cache.cacheFromUrl(USER, BOOK, 'reflow', 'https://files.test/cached.bookr.json');
  const cachedBookUrl = await cache.cachedUrl(USER, BOOK, 'book');
  const cachedReflowUrl = await cache.cachedUrl(USER, BOOK, 'reflow');

  const resolved = await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: true,
    fetchFile: async () => {
      throw new Error('network down');
    },
    fetchReflow: async () => {
      throw new Error('network down');
    },
  });

  expect(resolved.offline).toBe(true);
  expect(resolved.fileUrl).toBe(cachedBookUrl);
  expect(resolved.reflowUrl).toBe(cachedReflowUrl);
});

it('rethrows the request error when the network fails and nothing is cached', async () => {
  const { cache } = setup();

  await expect(
    resolveBookSource({
      cache,
      online: () => true,
      userId: USER,
      bookId: BOOK,
      reflowAvailable: false,
      fetchFile: async () => {
        throw new Error('HTTP 404');
      },
      fetchReflow: async () => null,
    }),
  ).rejects.toThrow('HTTP 404');
});

it('throws OfflineUnavailableError when offline and uncached', async () => {
  const { cache } = setup();
  const fetchFile = vi.fn(async () => ({ url: 'https://files.test/signed.pdf' }));

  const error: unknown = await resolveBookSource({
    cache,
    online: () => false,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile,
    fetchReflow: async () => null,
  }).catch((failure: unknown) => failure);

  expect(error).toBeInstanceOf(OfflineUnavailableError);
  expect((error as Error).message).toBe(OFFLINE_UNAVAILABLE_MESSAGE);
  expect((error as Error).message).toBe('这本书尚未下载到本机');
  expect(fetchFile).not.toHaveBeenCalled();
});

it('returns reflowUrl null when the pack is not cached offline', async () => {
  const { cache } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.pdf');
  const cachedBookUrl = await cache.cachedUrl(USER, BOOK, 'book');

  const resolved = await resolveBookSource({
    cache,
    online: () => false,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: true,
    fetchFile: async () => ({ url: 'https://files.test/signed.pdf' }),
    fetchReflow: async () => ({ url: 'https://files.test/pack.bookr.json' }),
  });

  expect(resolved.offline).toBe(true);
  expect(resolved.fileUrl).toBe(cachedBookUrl);
  expect(resolved.reflowUrl).toBeNull();
});

it('keeps online reading working when the cache backend fails', async () => {
  const db = createSyncDb(`book-source-${++sequence}`);
  openDbs.push(db);
  const healthy = createMemoryStore();
  const broken = {
    ...healthy,
    get: async (): Promise<Blob | null> => {
      throw new Error('cache store unavailable');
    },
    has: async (): Promise<boolean> => {
      throw new Error('cache store unavailable');
    },
  };
  const cache = createCacheManager({
    store: broken,
    db,
    // The automatic download is background work; fail it without a real request.
    fetchImpl: vi.fn(async () => {
      throw new Error('network down');
    }) as unknown as typeof fetch,
  });

  const resolved = await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: true,
    fetchFile: async () => ({ url: 'https://files.test/signed.pdf' }),
    fetchReflow: async () => {
      throw new Error('pack request failed');
    },
  });

  // The signed URL is already in hand; a broken cache probe only loses the
  // background refresh and the pack fallback, never the book itself.
  expect(resolved).toEqual({
    fileUrl: 'https://files.test/signed.pdf',
    reflowUrl: null,
    offline: false,
  });
});

it('marks the opened book as just read so the LRU keeps it', async () => {
  const { cache, db } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.pdf');
  await db.offlineBooks.put({
    bookId: BOOK,
    userId: USER,
    pinned: false,
    lastReadAt: 0,
    cachedAt: 0,
    bytes: 10,
  });

  await resolveBookSource({
    cache,
    online: () => false,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile: async () => ({ url: 'https://files.test/signed.pdf' }),
    fetchReflow: async () => null,
  });

  const row = await db.offlineBooks.get([USER, BOOK]);
  expect(row?.lastReadAt).toBeGreaterThan(0);
});

/** Opens a book online and waits for the background download to land. */
async function openOnline(
  cache: CacheManager,
  db: BookrDb,
  bookId: string,
): Promise<void> {
  await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId,
    reflowAvailable: false,
    fetchFile: async () => ({ url: `https://files.test/${bookId}.epub` }),
    fetchReflow: async () => null,
  });
  await vi.waitFor(async () => {
    expect(await db.offlineBooks.get([USER, bookId])).toBeDefined();
  });
}

it('evicts the oldest unpinned book when a sixth book is opened', async () => {
  const { cache, db } = setup();

  for (let index = 0; index < 6; index += 1) {
    await openOnline(cache, db, `book-${index}`);
  }

  await vi.waitFor(async () => {
    expect(await db.offlineBooks.get([USER, 'book-0'])).toBeUndefined();
  });
  expect(await cache.cachedUrl(USER, 'book-0', 'book')).toBeNull();
  const remaining = (await db.offlineBooks.where('userId').equals(USER).toArray())
    .map((row) => row.bookId)
    .sort();
  expect(remaining).toEqual(['book-1', 'book-2', 'book-3', 'book-4', 'book-5']);
});

it('never evicts a pinned book from the recent window', async () => {
  const { cache, db } = setup();
  await cache.pin(USER, 'book-0');

  for (let index = 0; index < 7; index += 1) {
    await openOnline(cache, db, `book-${index}`);
  }

  await vi.waitFor(async () => {
    expect(await db.offlineBooks.get([USER, 'book-1'])).toBeUndefined();
  });
  expect((await db.offlineBooks.get([USER, 'book-0']))?.pinned).toBe(true);
  await vi.waitFor(async () => {
    expect(await cache.cachedUrl(USER, 'book-0', 'book')).not.toBeNull();
  });
});

it('does not re-download a copy cached less than a day ago', async () => {
  const { cache, fetchImpl } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');
  fetchImpl.mockClear();

  await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile: async () => ({ url: 'https://files.test/signed.epub' }),
    fetchReflow: async () => null,
  });

  // The refresh decision is asynchronous; give the background task time to run
  // and prove it did not fetch the signed URL again.
  await new Promise((resolve) => setTimeout(resolve, 25));
  expect(fetchImpl).not.toHaveBeenCalled();
});

it('refreshes a copy cached more than a day ago', async () => {
  const { cache, db, fetchImpl } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');
  await db.offlineBooks.update([USER, BOOK], {
    cachedAt: Date.now() - CACHE_REFRESH_AFTER_MS - 1_000,
  });
  fetchImpl.mockClear();

  await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile: async () => ({ url: 'https://files.test/signed.epub' }),
    fetchReflow: async () => null,
  });

  await vi.waitFor(() =>
    expect(fetchImpl).toHaveBeenCalledWith('https://files.test/signed.epub'),
  );
});

it('restores a copy whose cached file disappeared', async () => {
  const { cache, fetchImpl, store } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');
  await store.delete(cacheKey(USER, BOOK, 'book'));
  fetchImpl.mockClear();

  await resolveBookSource({
    cache,
    online: () => true,
    userId: USER,
    bookId: BOOK,
    reflowAvailable: false,
    fetchFile: async () => ({ url: 'https://files.test/signed.epub' }),
    fetchReflow: async () => null,
  });

  await vi.waitFor(() =>
    expect(fetchImpl).toHaveBeenCalledWith('https://files.test/signed.epub'),
  );
  await vi.waitFor(async () => {
    expect(await cache.cachedUrl(USER, BOOK, 'book')).not.toBeNull();
  });
});
