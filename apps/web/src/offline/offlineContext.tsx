import { createContext, useContext, useState } from 'react';
import type { ReactNode } from 'react';
import { createSyncDb } from '../sync/db';
import type { BookrDb } from '../sync/db';
import { createCacheManager } from './cacheManager';
import type { CacheManager } from './cacheManager';
import { createDefaultStore } from './fileStore';
import type { CachedFileStore } from './fileStore';

/** Everything needed to keep books on the device for one browser. */
export interface OfflineSession {
  db: BookrDb;
  store: CachedFileStore;
  cache: CacheManager;
}

export interface CreateOfflineSessionOptions {
  /** Test seam; production opens the shared local database. */
  db?: BookrDb;
  /** Test seam; production probes OPFS, then IndexedDB, then memory. */
  store?: CachedFileStore;
  /** Test seam for downloads; production uses `globalThis.fetch`. */
  fetchImpl?: typeof fetch;
}

/**
 * Picks the file backend lazily. Probing OPFS/IndexedDB is asynchronous but
 * components need a synchronous session to render, so the probe starts with
 * the first cache operation instead of at construction.
 */
function createDeferredStore(): CachedFileStore {
  let backend: Promise<CachedFileStore> | null = null;
  const resolve = (): Promise<CachedFileStore> => (backend ??= createDefaultStore());
  return {
    put: (key, data) => resolve().then((store) => store.put(key, data)),
    get: (key) => resolve().then((store) => store.get(key)),
    has: (key) => resolve().then((store) => store.has(key)),
    delete: (key) => resolve().then((store) => store.delete(key)),
    keys: () => resolve().then((store) => store.keys()),
    totalBytes: () => resolve().then((store) => store.totalBytes()),
    clear: () => resolve().then((store) => store.clear()),
  };
}

/** Builds an isolated session; tests use it to avoid the shared database. */
export function createOfflineSession(
  options: CreateOfflineSessionOptions = {},
): OfflineSession {
  const db = options.db ?? createSyncDb();
  const store = options.store ?? createDeferredStore();
  const cache = createCacheManager({
    db,
    store,
    ...(options.fetchImpl === undefined ? {} : { fetchImpl: options.fetchImpl }),
  });
  return { db, store, cache };
}

let shared: OfflineSession | null = null;

/**
 * Fallback for components rendered without a provider (isolated tests, or a
 * route mounted outside the app shell). Production mounts `OfflineProvider` in
 * `AppProviders`, which owns its own session instead of relying on this.
 */
export function getOfflineSession(): OfflineSession {
  shared ??= createOfflineSession();
  return shared;
}

const OfflineContext = createContext<OfflineSession | null>(null);

/**
 * Owns the cache session for the app shell. It opens a second connection to
 * the `bookr-sync` database because the sync engine owns its own; cache rows
 * are written only through this connection, and the shelf's live queries read
 * through the same one, so the two never fight over updates.
 */
export function OfflineProvider({
  children,
  session,
}: {
  children: ReactNode;
  /** Test injection; production creates the session the provider owns. */
  session?: OfflineSession;
}) {
  const [value] = useState(() => session ?? createOfflineSession());
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOfflineSession(): OfflineSession {
  return useContext(OfflineContext) ?? getOfflineSession();
}
