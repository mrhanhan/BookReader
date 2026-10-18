import { useCallback, useEffect, useRef, useState } from 'react';
import type { Locator } from '@bookr/shared';
import type { ReaderEngine } from '@bookr/reader-core';
import { useSync } from '../../sync/SyncProvider';
import type { SyncState } from '../../sync/engine';
import { locatorsEqual, writeLocalProgress } from './progressStore';

/** The local cache is written at most once per this interval (leading + trailing). */
export const LOCAL_WRITE_INTERVAL_MS = 5_000;
/** A pending position is handed to the sync engine at most this often. */
export const SYNC_REQUEST_INTERVAL_MS = 25_000;

export type ReaderSaveState = 'saved' | 'saving' | 'error';

/** Chinese labels shared by the chrome status line and the sync badge. */
export const SAVE_STATE_LABELS: Record<ReaderSaveState, string> = {
  saved: '已保存',
  saving: '保存中',
  error: '未同步',
};

export interface UseReaderProgressOptions {
  /** Signed-in account; the local store is namespaced per user. */
  userId: string;
  bookId: string;
  /** Null until the book kind is known; the hook subscribes as soon as it exists. */
  engine: ReaderEngine | null;
  initialLocator?: Locator;
}

export interface ReaderProgressState {
  /** 0–1 book position, driven by the engine's `relocated` events. */
  percent: number;
  saveState: ReaderSaveState;
  /**
   * Ignores the next relocation when it lands on `locator`. The reader calls
   * this before navigating to a position the sync engine just applied, so
   * following the server does not queue the same position back again.
   */
  suppressNext: (locator: Locator) => void;
}

function clampPercent(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** The sync engine owns delivery; its state is the reader's status line. */
export function saveStateFor(state: SyncState): ReaderSaveState {
  switch (state.status) {
    case 'synced':
      return state.pending > 0 ? 'saving' : 'saved';
    case 'syncing':
    case 'pending':
      return 'saving';
    case 'offline':
    case 'error':
      return 'error';
  }
}

/**
 * Persists reading progress locally without ever blocking the reader.
 *
 * Every write lands in Dexie and its outbox (at most once per five seconds),
 * and the sync engine delivers it. The twenty-five-second tick, page hide and
 * unmount only request a sync; they never call the HTTP endpoint directly.
 */
export function useReaderProgress({
  userId,
  bookId,
  engine,
  initialLocator,
}: UseReaderProgressOptions): ReaderProgressState {
  const { repo, state: syncState, requestSync } = useSync();
  const [percent, setPercent] = useState(() => clampPercent(initialLocator?.percent ?? 0));

  const locatorRef = useRef<Locator | null>(initialLocator ?? null);
  const dirtyRef = useRef(false);
  const lastLocalWriteRef = useRef(0);
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  // The latest resolved position, readable from the subscription closure.
  const initialLocatorRef = useRef<Locator | undefined>(initialLocator);
  initialLocatorRef.current = initialLocator;
  // The first relocation after opening usually just confirms where the book
  // was opened. Writing it would queue a stale position before the first pull
  // can deliver a newer one from another device.
  const awaitingInitialRef = useRef(true);
  // Set just before following a server-applied position; the relocation it
  // causes must not become a local write.
  const suppressedRef = useRef<Locator | null>(null);

  const suppressNext = useCallback((locator: Locator) => {
    suppressedRef.current = locator;
  }, []);

  // Seed from the resolved local position once it is known; this runs before
  // the page's own effect calls `engine.open`.
  useEffect(() => {
    locatorRef.current = initialLocator ?? null;
    dirtyRef.current = false;
    awaitingInitialRef.current = true;
    suppressedRef.current = null;
    setPercent(clampPercent(initialLocator?.percent ?? 0));
  }, [userId, bookId, initialLocator]);

  useEffect(() => {
    if (!engine || !bookId || !userId) return;
    awaitingInitialRef.current = true;

    const write = (locator: Locator): void => {
      const now = Date.now();
      lastLocalWriteRef.current = now;
      writeLocalProgress(repo, userId, bookId, locator, now);
    };

    const record = (locator: Locator): void => {
      setPercent(clampPercent(locator.percent));

      const suppressed = suppressedRef.current;
      if (suppressed !== null && locatorsEqual(locator, suppressed)) {
        // The reader navigated to the position the server just applied; the
        // local store already holds it, so there is nothing to save.
        suppressedRef.current = null;
        locatorRef.current = locator;
        dirtyRef.current = false;
        return;
      }
      suppressedRef.current = null;

      if (awaitingInitialRef.current) {
        awaitingInitialRef.current = false;
        const initial = initialLocatorRef.current;
        if (initial !== undefined && locatorsEqual(locator, initial)) {
          // Opened where the stored position said; do not queue it back.
          locatorRef.current = locator;
          dirtyRef.current = false;
          return;
        }
      }

      locatorRef.current = locator;
      dirtyRef.current = true;

      const elapsed = Date.now() - lastLocalWriteRef.current;
      if (elapsed >= LOCAL_WRITE_INTERVAL_MS) {
        write(locator);
        return;
      }
      // The trailing write keeps the last position of a burst even when every
      // event lands inside the throttle window.
      if (trailingRef.current === null) {
        trailingRef.current = setTimeout(() => {
          trailingRef.current = null;
          const pending = locatorRef.current;
          if (pending) write(pending);
        }, LOCAL_WRITE_INTERVAL_MS - elapsed);
      }
    };

    const unsubscribe = engine.on('relocated', ({ locator }) => record(locator));

    /** Writes the latest position (if any) and lets the engine push the outbox. */
    const handOff = (): void => {
      const locator = locatorRef.current;
      if (!locator || !dirtyRef.current) return;

      write(locator);
      dirtyRef.current = false;
      requestSync('progress');
    };

    const interval = setInterval(handOff, SYNC_REQUEST_INTERVAL_MS);

    const onPageHide = (): void => handOff();
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        handOff();
      }
    };

    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibilityChange);

    return () => {
      unsubscribe();
      clearInterval(interval);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
      if (trailingRef.current !== null) {
        clearTimeout(trailingRef.current);
        trailingRef.current = null;
      }
      handOff();
    };
  }, [bookId, engine, requestSync, repo, userId]);

  return { percent, saveState: saveStateFor(syncState), suppressNext };
}
