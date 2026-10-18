import { useQueryClient } from '@tanstack/react-query';
import { createContext, useCallback, useContext, useEffect, useMemo, useRef, useState } from 'react';
import type { ReactNode } from 'react';
import { createSyncApi } from '../api/sync';
import { useAuth } from '../app/auth';
import { createSyncDb } from './db';
import { createSyncEngine } from './engine';
import type { ConflictNotice, SyncEngine, SyncEngineOptions, SyncState } from './engine';
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

export type ConflictListener = (notice: ConflictNotice) => void;

/** Resolves once the engine completes its first sync for this session. */
interface FirstSyncGate {
  promise: Promise<void>;
  resolve: () => void;
}

function createFirstSyncGate(): FirstSyncGate {
  let resolve: () => void = () => {};
  const promise = new Promise<void>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

export interface SyncContextValue {
  repo: LocalRepository;
  state: SyncState;
  syncNow: (reason?: string) => Promise<void>;
  /** Debounced sync request for local writes; the engine pushes once the burst ends. */
  requestSync: (reason?: string) => void;
  /**
   * Resolves when this session's first sync completes, or after `timeoutMs`
   * when the engine is offline or still busy. Never rejects.
   */
  waitForFirstSync: (timeoutMs: number) => Promise<void>;
  /** Conflict notifications resolved after the provider mounted. */
  subscribeConflicts: (listener: ConflictListener) => () => void;
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
  const conflictListenersRef = useRef(new Set<ConflictListener>());
  // Created during render so a child that reads it before the provider's own
  // mount effect runs still waits for this session's first sync.
  const firstSyncRef = useRef<FirstSyncGate | null>(null);
  if (firstSyncRef.current === null) {
    firstSyncRef.current = createFirstSyncGate();
  }

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
      const pending = firstSyncRef.current;
      firstSyncRef.current = null;
      pending?.resolve();
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
            // jsdom does not always provide EventSource; the browser build does.
            eventSourceFactory:
              typeof EventSource === 'undefined'
                ? undefined
                : (url: string) => new EventSource(url),
            onChange: handleEngineEvent,
          })
        : factory(userId, deps.repo);

    engineRef.current = engine;
    const gate = firstSyncRef.current ?? createFirstSyncGate();
    firstSyncRef.current = gate;
    // Conflicts counted before this effect runs are the mount baseline; only
    // later increases are reported to subscribers.
    let previousConflicts = engine.getState().conflicts;

    const unsubscribe = engine.subscribe((next) => {
      setState(next);
      if (
        next.status === 'synced' ||
        next.status === 'offline' ||
        next.status === 'error'
      ) {
        gate.resolve();
      }
      if (next.conflicts > previousConflicts) {
        previousConflicts = next.conflicts;
        const notice = next.lastConflict;
        if (notice !== undefined) {
          for (const listener of conflictListenersRef.current) {
            listener(notice);
          }
        }
      } else {
        previousConflicts = next.conflicts;
      }
    });
    setState(engine.getState());
    engine.start();

    return () => {
      unsubscribe();
      void engine.stop();
      gate.resolve();
      if (firstSyncRef.current === gate) {
        firstSyncRef.current = null;
      }
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

  const waitForFirstSync = useCallback(async (timeoutMs: number): Promise<void> => {
    // A remount (React StrictMode, a provider above us) may have cleared the
    // gate between the render and this call; recreate it so the provider's
    // next mount adopts the same promise.
    let gate = firstSyncRef.current;
    if (gate === null) {
      gate = createFirstSyncGate();
      firstSyncRef.current = gate;
    }

    let timer: ReturnType<typeof setTimeout> | null = null;
    try {
      await Promise.race([
        gate.promise,
        new Promise<void>((resolve) => {
          timer = setTimeout(resolve, Math.max(0, timeoutMs));
        }),
      ]);
    } finally {
      if (timer !== null) {
        clearTimeout(timer);
      }
    }
  }, []);

  const subscribeConflicts = useCallback((listener: ConflictListener) => {
    const listeners = conflictListenersRef.current;
    listeners.add(listener);
    return () => {
      listeners.delete(listener);
    };
  }, []);

  const value = useMemo<SyncContextValue>(
    () => ({
      repo: deps.repo,
      state,
      syncNow,
      requestSync,
      waitForFirstSync,
      subscribeConflicts,
    }),
    [deps.repo, state, syncNow, requestSync, waitForFirstSync, subscribeConflicts],
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
