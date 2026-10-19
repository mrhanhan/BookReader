import { useEffect, useRef } from 'react';
import { newId, READING_SESSION_TICK_SECONDS } from '@bookr/shared';
import type { ReaderEngine } from '@bookr/reader-core';
import type { LocalRepository } from '../../sync/repository';
import {
  createReadingClock,
  type ReadingClockTick,
  type ReadingSessionSnapshot,
} from './readingClock';

/** Persistence cadence; the clock itself is tick-driven, not timer-driven. */
export const READING_TICK_INTERVAL_MS = READING_SESSION_TICK_SECONDS * 1_000;
/** Pointer moves arrive far faster than the two-minute idle window needs. */
const ACTIVITY_THROTTLE_MS = 1_000;

export interface UseReadingSessionOptions {
  userId: string | null;
  bookId: string | null;
  /** False while the book is still opening; nothing is counted then. */
  enabled: boolean;
  engine: ReaderEngine | null;
  repo: LocalRepository;
  requestSync: (reason?: string) => void;
}

/**
 * Counts active reading time and mirrors each session into the local store,
 * where the sync outbox carries it to the server (online or later).
 *
 * A session is flushed every 30 seconds and on every pause: hidden tab,
 * page unload, unmount, a new book, or the clock's own idle boundary.
 */
export function useReadingSession(options: UseReadingSessionOptions): void {
  const { userId, bookId, enabled, engine, repo, requestSync } = options;
  const clockRef = useRef<ReturnType<typeof createReadingClock> | null>(null);
  clockRef.current ??= createReadingClock();
  const sessionIdRef = useRef<string | null>(null);

  useEffect(() => {
    if (!enabled || !userId || !bookId) {
      return;
    }
    const clock = clockRef.current!;

    function persist(snapshot: ReadingSessionSnapshot, final: boolean): void {
      if (!userId || !bookId) {
        return;
      }
      const id = sessionIdRef.current ?? newId();
      sessionIdRef.current = id;
      void repo
        .saveReadingSession(userId, {
          id,
          bookId,
          startedAt: new Date(snapshot.startedAt).toISOString(),
          endedAt: new Date(snapshot.endedAt).toISOString(),
          activeSeconds: snapshot.activeSeconds,
          pagesRead: snapshot.pagesRead,
        })
        .then(() => requestSync('reading_session'))
        .catch(() => undefined);
      if (final) {
        sessionIdRef.current = null;
      }
    }

    function consume(tick: ReadingClockTick): void {
      // A closed session keeps its id; a segment that starts in the same tick
      // gets a fresh one on the next snapshot.
      if (tick.closed !== undefined) {
        persist(tick.closed, true);
      }
      if (tick.snapshot !== undefined) {
        persist(tick.snapshot, false);
      }
    }

    function flushFinal(): void {
      consume(clock.tick());
      const closed = clock.close();
      if (closed !== null) {
        persist(closed, true);
      }
    }

    function isForeground(): boolean {
      return document.visibilityState === 'visible' && document.hasFocus();
    }

    clock.setVisible(document.visibilityState === 'visible');
    clock.setFocused(document.hasFocus());
    // Opening the book is the first act of reading: it starts the session even
    // when the pointer never moves again.
    if (isForeground()) {
      clock.activity();
    }

    let lastActivityEvent = 0;
    const onActivity = (): void => {
      const at = Date.now();
      if (at - lastActivityEvent < ACTIVITY_THROTTLE_MS) {
        return;
      }
      lastActivityEvent = at;
      clock.activity(at);
    };

    const onVisibility = (): void => {
      const visible = document.visibilityState === 'visible';
      if (!visible) {
        // Count up to this instant before pausing; leaving the page must not
        // drop the seconds since the last heartbeat.
        flushFinal();
        clock.setVisible(false);
        return;
      }
      clock.setVisible(true);
      if (document.hasFocus()) {
        clock.activity();
      }
    };

    const onFocus = (): void => {
      clock.setFocused(true);
      clock.activity();
    };

    const onBlur = (): void => {
      consume(clock.tick());
      clock.setFocused(false);
    };

    const onPageHide = (): void => {
      flushFinal();
    };

    const offRelocated = engine?.on('relocated', () => clock.pageTurn());

    const timer = window.setInterval(() => consume(clock.tick()), READING_TICK_INTERVAL_MS);
    window.addEventListener('focus', onFocus);
    window.addEventListener('blur', onBlur);
    window.addEventListener('pagehide', onPageHide);
    document.addEventListener('visibilitychange', onVisibility);
    for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
      document.addEventListener(event, onActivity, { passive: true });
    }
    document.addEventListener('scroll', onActivity, { capture: true, passive: true });

    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
      window.removeEventListener('blur', onBlur);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibility);
      for (const event of ['pointerdown', 'pointermove', 'keydown', 'wheel', 'touchstart'] as const) {
        document.removeEventListener(event, onActivity);
      }
      document.removeEventListener('scroll', onActivity, true);
      offRelocated?.();
      flushFinal();
      sessionIdRef.current = null;
    };
  }, [enabled, engine, userId, bookId, repo, requestSync]);
}
