import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createSyncApi } from '../api/sync';
import { useAuth } from '../app/auth';
import { createSyncDb } from './db';
import { createSyncEngine } from './engine';
import type { SyncEngine, SyncEngineOptions, SyncState } from './engine';
import { createRepository } from './repository';
import type { LocalRepository } from './repository';

/** Shown before a user session exists and whenever it ends. */
export const DEFAULT_SYNC_STATE: SyncState = {
  status: 'synced',
  pending: 0,
  lastSyncedAt: null,
  conflicts: 0,
};

/** A burst of local writes results in one push two seconds after the last one. */
export const WRITE_SYNC_DELAY_MS = 2000;

export interface SyncContextValue {
  repo: LocalRepository;
  state: SyncState;
  syncNow: (reason?: string) => Promise<void>;
  /** Debounced sync request for local writes; the engine pushes once the burst ends. */
  requestSync: (reason?: string) => void;
}

export const SyncContext = createContext<SyncContextValue | null>(null);

export interface SyncProviderProps {
  children: ReactNode;
  /** Test injection; production uses createSyncDb/createRepository/createSyncEngine. */
  createEngine?: (userId: string, repo: LocalRepository) => SyncEngine;
  createRepo?: () => LocalRepository;
}

/**
 * Owns the per-account sync engine. Switching accounts stops the previous
 * engine before a new one starts, so no local write crosses the boundary.
 */
export function SyncProvider({ children, createEngine, createRepo }: SyncProviderProps) {
  const { user } = useAuth();
  const queryClient = useQueryClient();

  const [deps] = useState(() => {
    const db = createSyncDb();
    const repo = createRepo === undefined ? createRepository(db) : createRepo();
    return { db, repo };
  });

  const [state, setState] = useState<SyncState>(DEFAULT_SYNC_STATE);
  const engineRef = useRef<SyncEngine | null>(null);
  const createEngineRef = useRef(createEngine);
  createEngineRef.current = createEngine;
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  // Applied changes can touch any of the sync-backed queries; the reader keys
  // annotations by book, which a stream event does not carry, so invalidate the
  // whole roots and let the mounted queries refetch what they need.
  const handleEngineEvent = useCallback<NonNullable<SyncEngineOptions['onChange']>>(
    (_next, event) => {
      if (event?.type !== 'applied') {
        return;
      }
      void queryClient.invalidateQueries({ queryKey: ['annotations'] });
      void queryClient.invalidateQueries({ queryKey: ['bookmarks'] });
      void queryClient.invalidateQueries({ queryKey: ['progress'] });
      void queryClient.invalidateQueries({ queryKey: ['books'] });
    },
    [queryClient],
  );

  useEffect(() => {
    const userId = user?.id;
    if (userId === undefined) {
      setState(DEFAULT_SYNC_STATE);
      return;
    }

    const factory = createEngineRef.current;
    const engine =
      factory === undefined
        ? createSyncEngine({
            userId,
            db: deps.db,
            repo: deps.repo,
            api: createSyncApi(),
            onChange: handleEngineEvent,
          })
        : factory(userId, deps.repo);

    engineRef.current = engine;
    const unsubscribe = engine.subscribe(setState);
    setState(engine.getState());
    engine.start();

    return () => {
      unsubscribe();
      void engine.stop();
      if (engineRef.current === engine) {
        engineRef.current = null;
      }
    };
  }, [user?.id, deps, handleEngineEvent]);

  useEffect(
    () => () => {
      if (debounceRef.current !== null) {
        clearTimeout(debounceRef.current);
        debounceRef.current = null;
      }
    },
    [],
  );

  const syncNow = useCallback(async (reason?: string) => {
    await engineRef.current?.syncNow(reason);
  }, []);

  const requestSync = useCallback((reason = 'write') => {
    if (debounceRef.current !== null) {
      clearTimeout(debounceRef.current);
    }
    debounceRef.current = setTimeout(() => {
      debounceRef.current = null;
      void engineRef.current?.syncNow(reason);
    }, WRITE_SYNC_DELAY_MS);
  }, []);

  const value = useMemo<SyncContextValue>(
    () => ({ repo: deps.repo, state, syncNow, requestSync }),
    [deps.repo, state, syncNow, requestSync],
  );

  return <SyncContext.Provider value={value}>{children}</SyncContext.Provider>;
}

export function useSync(): SyncContextValue {
  const context = useContext(SyncContext);
  if (context === null) {
    throw new Error('useSync must be used inside <SyncProvider>');
  }
  return context;
}
