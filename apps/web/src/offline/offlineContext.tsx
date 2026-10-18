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
 * The app-wide session. It opens its own connection to the same local database
 * the sync engine uses; cache rows are only written through this connection,
 * so the live queries that read them stay consistent.
 */
export function getOfflineSession(): OfflineSession {
  shared ??= createOfflineSession();
  return shared;
}

const OfflineContext = createContext<OfflineSession | null>(null);

/** Provides an injected session in tests; production falls back to the shared one. */
export function OfflineProvider({
  children,
  session,
}: {
  children: ReactNode;
  session?: OfflineSession;
}) {
  const [value] = useState(() => session ?? getOfflineSession());
  return <OfflineContext.Provider value={value}>{children}</OfflineContext.Provider>;
}

export function useOfflineSession(): OfflineSession {
  return useContext(OfflineContext) ?? getOfflineSession();
}
