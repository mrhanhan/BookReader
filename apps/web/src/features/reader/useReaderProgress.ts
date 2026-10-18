import { useEffect, useRef, useState } from 'react';
import type { Locator } from '@bookr/shared';
import type { ReaderEngine } from '@bookr/reader-core';
import { saveProgress } from '../../api/reading';
import { writeLocalProgress } from './progressStore';

/** The local cache is written at most once per this interval (leading + trailing). */
export const LOCAL_WRITE_INTERVAL_MS = 5_000;
/** Dirty progress is pushed to the server at most this often. */
export const SERVER_SAVE_INTERVAL_MS = 30_000;

export type ReaderSaveState = 'saved' | 'saving' | 'error';

/** Chinese labels shared by the chrome status line and any future sync UI. */
export const SAVE_STATE_LABELS: Record<ReaderSaveState, string> = {
  saved: '已保存',
  saving: '保存中',
  error: '未同步',
};

export interface UseReaderProgressOptions {
  /** Signed-in account; the local cache is namespaced per user. */
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

/**
 * Persists reading progress without ever blocking the reader.
 *
 * Local storage is the fast path (leading write plus a trailing write at most
 * every five seconds); the server is written every thirty seconds only when the
 * position changed, and once more when the page is hidden or the reader closes.
 * Network and storage failures only change the visible sync label.
 */
export function useReaderProgress({
  userId,
  bookId,
  engine,
  initialLocator,
}: UseReaderProgressOptions): ReaderProgressState {
  const [percent, setPercent] = useState(() => clampPercent(initialLocator?.percent ?? 0));
  const [saveState, setSaveState] = useState<ReaderSaveState>('saved');

  const locatorRef = useRef<Locator | null>(initialLocator ?? null);
  const dirtyRef = useRef(false);
  const lastLocalWriteRef = useRef(0);
  const trailingRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const generationRef = useRef(0);

  // Seed from the resolved server/cache position once it is known; this runs
  // before the page's own effect calls `engine.open`.
  useEffect(() => {
    locatorRef.current = initialLocator ?? null;
    dirtyRef.current = false;
    setPercent(clampPercent(initialLocator?.percent ?? 0));
  }, [userId, bookId, initialLocator]);

  useEffect(() => {
    if (!engine || !bookId || !userId) return;
    const generation = ++generationRef.current;

    const writeLocal = (locator: Locator): void => {
      const now = Date.now();
      lastLocalWriteRef.current = now;
      writeLocalProgress(userId, bookId, locator, now);
    };

    const record = (locator: Locator): void => {
      locatorRef.current = locator;
      dirtyRef.current = true;
      setPercent(clampPercent(locator.percent));

      const elapsed = Date.now() - lastLocalWriteRef.current;
      if (elapsed >= LOCAL_WRITE_INTERVAL_MS) {
        writeLocal(locator);
        return;
      }
      // The trailing write keeps the last position of a burst even when every
      // event lands inside the throttle window.
      if (trailingRef.current === null) {
        trailingRef.current = setTimeout(() => {
          trailingRef.current = null;
          const pending = locatorRef.current;
          if (pending) writeLocal(pending);
        }, LOCAL_WRITE_INTERVAL_MS - elapsed);
      }
    };

    const unsubscribe = engine.on('relocated', ({ locator }) => record(locator));

    const flush = async (): Promise<void> => {
      const locator = locatorRef.current;
      if (!locator) return;
      // An idle tick must not renew a stale cache entry; only a changed
      // position is written locally and pushed to the server.
      if (!dirtyRef.current) return;

      writeLocal(locator);
      dirtyRef.current = false;
      if (generationRef.current === generation) setSaveState('saving');
      try {
        await saveProgress(bookId, locator);
        if (generationRef.current === generation) setSaveState('saved');
      } catch {
        // A failed sync keeps the position dirty for the next interval/flush.
        dirtyRef.current = true;
        if (generationRef.current === generation) setSaveState('error');
      }
    };

    const interval = setInterval(() => {
      void flush();
    }, SERVER_SAVE_INTERVAL_MS);

    const onPageHide = (): void => {
      void flush();
    };
    const onVisibilityChange = (): void => {
      if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
        void flush();
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
      // Invalidate in-flight state updates, but still send the final position.
      generationRef.current += 1;
      void flush();
    };
  }, [bookId, engine, userId]);

  return { percent, saveState };
}
