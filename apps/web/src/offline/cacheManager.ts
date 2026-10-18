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

  function revokeUrl(key: string): void {
    const cached = urls.get(key);
    if (!cached) return;
    urls.delete(key);
    cached.revoke();
  }

  /** Cache rows are keyed by book, so a row owned by another user is invisible. */
  async function rowFor(userId: string, bookId: string): Promise<OfflineBookRow | null> {
    const row = await db.offlineBooks.get(bookId);
    return row && row.userId === userId ? row : null;
  }

  async function rowsFor(userId: string): Promise<OfflineBookRow[]> {
    return db.offlineBooks.where('userId').equals(userId).toArray();
  }

  async function removeCachedBook(userId: string, bookId: string): Promise<void> {
    for (const kind of CACHE_KINDS) {
      const key = cacheKey(userId, bookId, kind);
      await store.delete(key);
      revokeUrl(key);
    }

    // Only the cache row is removed here. Annotations, bookmarks, progress and
    // outbox rows must survive eviction so reading data is never lost.
    const row = await rowFor(userId, bookId);
    if (row) await db.offlineBooks.delete(row.bookId);
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
      const previous = await store.get(key);

      // The old object URL pointed at the replaced blob; invalidate it first.
      revokeUrl(key);
      await store.put(key, blob);

      const current = await rowFor(userId, bookId);
      const timestamp = now();
      await db.offlineBooks.put({
        bookId,
        userId,
        pinned: current?.pinned ?? false,
        lastReadAt: current?.lastReadAt ?? timestamp,
        cachedAt: timestamp,
        bytes: Math.max(0, (current?.bytes ?? 0) - (previous?.size ?? 0) + blob.size),
      });

      return blob.size;
    },

    async cachedUrl(userId, bookId, kind) {
      const key = cacheKey(userId, bookId, kind);
      const existing = urls.get(key);
      if (existing) return existing.url;

      const blob = await store.get(key);
      if (!blob) return null;

      const created = await createObjectUrl(blob);
      urls.set(key, created);
      return created.url;
    },

    async touch(userId, bookId) {
      const row = await rowFor(userId, bookId);
      if (!row) return;
      await db.offlineBooks.put({ ...row, lastReadAt: now() });
    },

    async pin(userId, bookId) {
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
    },

    async unpin(userId, bookId) {
      const row = await rowFor(userId, bookId);
      if (row?.pinned) await db.offlineBooks.put({ ...row, pinned: false });
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
        .filter((row) => !row.pinned && row.bookId !== keepBookId)
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
