import { useEffect, useRef, useState } from 'react';
import type { Locator } from '@bookr/shared';
import type { ReaderEngine } from '@bookr/reader-core';
import { useSync } from '../../sync/SyncProvider';
import type { SyncState } from '../../sync/engine';
import { locatorsEqual, writeLegacyProgress, writeLocalProgress } from './progressStore';

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
 * Every write lands in Dexie and its outbox (at most once per five seconds)
 * and is mirrored synchronously into the legacy localStorage buffer, so a
 * reload or crash immediately after the last event still finds the position.
 * The twenty-five-second tick, page hide and unmount request a sync; they
 * never call the HTTP endpoint directly.
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

  // Seed from the resolved local position once it is known; this runs before
  // the page's own effect calls `engine.open`.
  useEffect(() => {
    locatorRef.current = initialLocator ?? null;
    dirtyRef.current = false;
    awaitingInitialRef.current = true;
    setPercent(clampPercent(initialLocator?.percent ?? 0));
  }, [userId, bookId, initialLocator]);

  useEffect(() => {
    if (!engine || !bookId || !userId) return;
    awaitingInitialRef.current = true;

    const write = (locator: Locator): Promise<boolean> => {
      const now = Date.now();
      // Flush the synchronous buffer before the async transaction starts: a
      // reload right after this event cannot await IndexedDB, but it can read
      // this entry during the next open.
      writeLegacyProgress(userId, bookId, locator, now);
      return writeLocalProgress(repo, userId, bookId, locator, now).then((saved) => {
        // A failed write leaves the throttle open so the next event retries.
        if (saved) {
          lastLocalWriteRef.current = now;
        }
        return saved;
      });
    };

    const record = (locator: Locator): void => {
      setPercent(clampPercent(locator.percent));

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

    /**
     * Writes the latest position (if any) and lets the engine push the outbox.
     * `write` flushes the synchronous legacy buffer before its first `await`,
     * so the last position survives a `pagehide` that tears the page down
     * before the Dexie transaction commits. The sync request does not wait for
     * that transaction either.
     */
    const handOff = (): void => {
      const locator = locatorRef.current;
      if (!locator || !dirtyRef.current) return;

      void write(locator).then((saved) => {
        if (!saved) {
          // Keep the position dirty so the next tick, page hide or unmount
          // retries the local write.
          return;
        }
        // A newer position may have arrived while the write was in flight;
        // keep the flag so the next cycle hands that one off too.
        const latest = locatorRef.current;
        if (latest === null || locatorsEqual(latest, locator)) {
          dirtyRef.current = false;
        }
      });
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

  return { percent, saveState: saveStateFor(syncState) };
}
