import type { BookrDb } from '../sync/db';
import type { OfflineBookRow } from '../sync/types';
import { cacheKey, type CacheKind, type CachedFileStore } from './fileStore';

/** How many unpinned books stay available offline beyond the pinned ones. */
export const OFFLINE_RECENT_LIMIT = 5;

const CACHE_KINDS: readonly CacheKind[] = ['book', 'reflow'];

export interface CacheManager {
  /** Downloads `url` into the cache and reports the stored byte size. */
  cacheFromUrl(userId: string, bookId: string, kind: CacheKind, url: string): Promise<number>;
  /** Returns a stable object URL for a cached file, or null when it is absent. */
  cachedUrl(userId: string, bookId: string, kind: CacheKind): Promise<string | null>;
  /** Epoch milliseconds of the last download, or null when no cache row exists. */
  cachedAt(userId: string, bookId: string): Promise<number | null>;
  touch(userId: string, bookId: string): Promise<void>;
  pin(userId: string, bookId: string): Promise<void>;
  unpin(userId: string, bookId: string): Promise<void>;
  isPinned(userId: string, bookId: string): Promise<boolean>;
  /** Deletes cached files and the cache row; reading data is never touched. */
  remove(userId: string, bookId: string): Promise<void>;
  /** Evicts unpinned books by last-read time, keeping the most recent five. */
  enforceLru(userId: string, keepBookId?: string): Promise<string[]>;
  /** Drops every unpinned book except `keepBookId`; returns the evicted ids. */
  clearUnpinned(userId: string, keepBookId?: string): Promise<string[]>;
  usage(
    userId: string,
  ): Promise<{ bytes: number; books: OfflineBookRow[]; quota: number | null }>;
  revokeUrls(): void;
}

interface ObjectUrl {
  url: string;
  revoke: () => void;
}

/**
 * Object URLs only exist in browsers; jsdom (and other non-browser hosts) lack
 * `URL.createObjectURL`. A data URL keeps the cache readable there, and the
 * stable entry in the URL map still guarantees reuse.
 */
async function blobToDataUrl(blob: Blob): Promise<string> {
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let binary = '';
  const chunkSize = 0x8000;
  for (let offset = 0; offset < bytes.length; offset += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + chunkSize));
  }
  return `data:${blob.type || 'application/octet-stream'};base64,${btoa(binary)}`;
}

async function createObjectUrl(blob: Blob): Promise<ObjectUrl> {
  if (typeof URL.createObjectURL === 'function') {
    const url = URL.createObjectURL(blob);
    return { url, revoke: () => URL.revokeObjectURL(url) };
  }
  return { url: await blobToDataUrl(blob), revoke: () => undefined };
}

async function readQuota(): Promise<number | null> {
  const storage = typeof navigator === 'undefined' ? undefined : navigator.storage;
  if (!storage || typeof storage.estimate !== 'function') return null;
  try {
    const estimate = await storage.estimate();
    return typeof estimate.quota === 'number' ? estimate.quota : null;
  } catch {
    return null;
  }
}

export function createCacheManager(deps: {
  store: CachedFileStore;
  db: BookrDb;
  now?: () => number;
  fetchImpl?: typeof fetch;
}): CacheManager {
  const { store, db } = deps;
  const now = deps.now ?? (() => Date.now());
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const urls = new Map<string, ObjectUrl>();
  const pendingUrls = new Map<string, Promise<string | null>>();
  const rowLocks = new Map<string, Promise<unknown>>();

  /**
   * Serializes read-modify-write cycles on one cache row. Without it the book
   * and reflow downloads (or a pin racing a download) would each read the same
   * old row and the last writer would win, losing bytes or the pinned flag.
   */
  function withRowLock<T>(userId: string, bookId: string, action: () => Promise<T>): Promise<T> {
    const lockKey = `${userId}/${bookId}`;
    const previous = rowLocks.get(lockKey) ?? Promise.resolve();
    // Run the action whether the previous update resolved or failed.
    const next = previous.then(action, action);
    rowLocks.set(lockKey, next);

    const release = (): void => {
      if (rowLocks.get(lockKey) === next) rowLocks.delete(lockKey);
    };
    void next.then(release, release);
    return next;
  }

  function revokeUrl(key: string): void {
    const cached = urls.get(key);
    if (!cached) return;
    urls.delete(key);
    cached.revoke();
  }

  /** Cache rows are keyed by user and book so accounts never share one row. */
  async function rowFor(userId: string, bookId: string): Promise<OfflineBookRow | null> {
    return (await db.offlineBooks.get([userId, bookId])) ?? null;
  }

  async function rowsFor(userId: string): Promise<OfflineBookRow[]> {
    return db.offlineBooks.where('userId').equals(userId).toArray();
  }

  async function hasCachedFiles(userId: string, bookId: string): Promise<boolean> {
    for (const kind of CACHE_KINDS) {
      if (await store.has(cacheKey(userId, bookId, kind))) return true;
    }
    return false;
  }

  async function deleteCachedBook(userId: string, bookId: string): Promise<void> {
    for (const kind of CACHE_KINDS) {
      const key = cacheKey(userId, bookId, kind);
      await store.delete(key);
      revokeUrl(key);
    }

    // Only the cache row is removed here. Annotations, bookmarks, progress and
    // outbox rows must survive eviction so reading data is never lost.
    await db.offlineBooks.delete([userId, bookId]);
  }

  function removeCachedBook(userId: string, bookId: string): Promise<void> {
    return withRowLock(userId, bookId, () => deleteCachedBook(userId, bookId));
  }

  async function evict(userId: string, rows: OfflineBookRow[]): Promise<string[]> {
    const evicted: string[] = [];
    for (const row of rows) {
      await removeCachedBook(userId, row.bookId);
      evicted.push(row.bookId);
    }
    return evicted;
  }

  function byLeastRecentlyRead(left: OfflineBookRow, right: OfflineBookRow): number {
    return left.lastReadAt - right.lastReadAt || left.bookId.localeCompare(right.bookId);
  }

  return {
    async cacheFromUrl(userId, bookId, kind, url) {
      const response = await doFetch(url);
      if (!response.ok) {
        throw new Error(`Unable to download ${url} (HTTP ${response.status})`);
      }

      const blob = await response.blob();
      const key = cacheKey(userId, bookId, kind);

      await withRowLock(userId, bookId, async () => {
        // Reading the replaced file and writing the new one inside the lock
        // keeps two concurrent re-downloads of the same kind from each
        // subtracting the same old size and inflating the row.
        const previous = await store.get(key);
        // The old object URL pointed at the replaced blob; invalidate it first.
        revokeUrl(key);
        await store.put(key, blob);

        const row = await rowFor(userId, bookId);
        const timestamp = now();
        // A missing row carries no baseline; the file left on disk is replaced
        // wholesale, so the new file size is the accurate total.
        const bytes = row
          ? Math.max(0, row.bytes - (previous?.size ?? 0) + blob.size)
          : blob.size;

        await db.offlineBooks.put({
          bookId,
          userId,
          pinned: row?.pinned ?? false,
          lastReadAt: row?.lastReadAt ?? timestamp,
          cachedAt: timestamp,
          bytes,
        });
      });

      return blob.size;
    },

    async cachedUrl(userId, bookId, kind) {
      const key = cacheKey(userId, bookId, kind);
      const existing = urls.get(key);
      if (existing) return existing.url;

      // Two readers can ask for the same book at once; share one in-flight
      // object URL instead of creating a second handle for the same bytes.
      const pending = pendingUrls.get(key);
      if (pending) return pending;

      const task = (async (): Promise<string | null> => {
        const blob = await store.get(key);
        if (!blob) return null;

        const created = await createObjectUrl(blob);
        urls.set(key, created);
        return created.url;
      })();
      pendingUrls.set(key, task);

      try {
        return await task;
      } finally {
        if (pendingUrls.get(key) === task) pendingUrls.delete(key);
      }
    },

    async cachedAt(userId, bookId) {
      return (await rowFor(userId, bookId))?.cachedAt ?? null;
    },

    async touch(userId, bookId) {
      await withRowLock(userId, bookId, async () => {
        const row = await rowFor(userId, bookId);
        if (!row) return;
        await db.offlineBooks.put({ ...row, lastReadAt: now() });
      });
    },

    async pin(userId, bookId) {
      await withRowLock(userId, bookId, async () => {
        const row = await rowFor(userId, bookId);
        if (row) {
          if (!row.pinned) await db.offlineBooks.put({ ...row, pinned: true });
          return;
        }

        // Pinning before the download finishes still has to be observable, so a
        // placeholder row records the intent until the bytes land.
        const timestamp = now();
        await db.offlineBooks.put({
          bookId,
          userId,
          pinned: true,
          lastReadAt: timestamp,
          cachedAt: timestamp,
          bytes: 0,
        });
      });
    },

    async unpin(userId, bookId) {
      await withRowLock(userId, bookId, async () => {
        const row = await rowFor(userId, bookId);
        if (!row) return;

        // An unpinned placeholder without files is not a cached book; keeping
        // it would consume one of the recent five LRU slots.
        if (row.bytes === 0 && !(await hasCachedFiles(userId, bookId))) {
          await db.offlineBooks.delete([userId, bookId]);
          return;
        }
        if (row.pinned) await db.offlineBooks.put({ ...row, pinned: false });
      });
    },

    async isPinned(userId, bookId) {
      return (await rowFor(userId, bookId))?.pinned === true;
    },

    async remove(userId, bookId) {
      await removeCachedBook(userId, bookId);
    },

    async enforceLru(userId, keepBookId) {
      const rows = await rowsFor(userId);
      const candidates = rows
        // Placeholder rows carry no bytes; they are not real cache entries.
        .filter((row) => !row.pinned && row.bookId !== keepBookId && row.bytes > 0)
        .sort(byLeastRecentlyRead);

      // Pinned books and the book currently being read sit outside the recent
      // window, so only the unpinned candidates compete for the five slots.
      const excess = candidates.length - OFFLINE_RECENT_LIMIT;
      if (excess <= 0) return [];
      return evict(userId, candidates.slice(0, excess));
    },

    async clearUnpinned(userId, keepBookId) {
      const rows = await rowsFor(userId);
      const removable = rows
        .filter((row) => !row.pinned && row.bookId !== keepBookId)
        .sort(byLeastRecentlyRead);
      return evict(userId, removable);
    },

    async usage(userId) {
      const rows = await rowsFor(userId);
      const books = [...rows].sort((left, right) => byLeastRecentlyRead(right, left));
      return {
        bytes: books.reduce((total, row) => total + row.bytes, 0),
        books,
        quota: await readQuota(),
      };
    },

    revokeUrls() {
      for (const cached of urls.values()) cached.revoke();
      urls.clear();
    },
  };
}
