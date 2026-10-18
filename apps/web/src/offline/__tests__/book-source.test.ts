import { afterEach, expect, it, vi } from 'vitest';
import { createSyncDb } from '../../sync/db';
import type { BookrDb } from '../../sync/db';
import {
  OfflineUnavailableError,
  OFFLINE_UNAVAILABLE_MESSAGE,
  resolveBookSource,
} from '../bookSource';
import { createCacheManager } from '../cacheManager';
import { createMemoryStore } from '../fileStore';

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
  const cache = createCacheManager({
    store: createMemoryStore(),
    db,
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
  return { cache, db, fetchImpl };
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

it('does not download a book that was never kept on the device', async () => {
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
  expect(fetchImpl).not.toHaveBeenCalled();
  expect(await db.offlineBooks.get([USER, BOOK])).toBeUndefined();
});

it('falls back to the cached blob when the network fails', async () => {
  const { cache } = setup();
  await cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.pdf');
  await cache.cacheFromUrl(USER, BOOK, 'reflow', 'https://files.test/cached.bookr.json');

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
  expect(resolved.fileUrl).not.toBe('https://files.test/cached.pdf');
  expect(resolved.fileUrl.length).toBeGreaterThan(0);
  expect(resolved.reflowUrl).not.toBeNull();
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
  expect(resolved.fileUrl.length).toBeGreaterThan(0);
  expect(resolved.reflowUrl).toBeNull();
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
