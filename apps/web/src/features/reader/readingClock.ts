import {
  READING_IDLE_PAUSE_SECONDS,
  READING_SESSION_MAX_SEGMENT_SECONDS,
} from '@bookr/shared';

/** One open or finished session, with cumulative values. */
export interface ReadingSessionSnapshot {
  /** Epoch milliseconds when the first second of this session was counted. */
  startedAt: number;
  /** Epoch milliseconds of the last counted moment (or the idle boundary). */
  endedAt: number;
  activeSeconds: number;
  pagesRead: number;
}

/** What one 30-second tick produced. */
export interface ReadingClockTick {
  /** The open session's cumulative state, when it changed. */
  snapshot?: ReadingSessionSnapshot;
  /** A session that ended during this tick; persist it as final. */
  closed?: ReadingSessionSnapshot;
}

export interface ReadingClockOptions {
  now?: () => number;
  idleMs?: number;
  maxSegmentMs?: number;
}

export interface ReadingClock {
  activity(at?: number): void;
  pageTurn(at?: number): void;
  setVisible(visible: boolean, at?: number): void;
  setFocused(focused: boolean, at?: number): void;
  tick(at?: number): ReadingClockTick;
  close(at?: number): ReadingSessionSnapshot | null;
  isActive(at?: number): boolean;
  current(at?: number): ReadingSessionSnapshot | null;
}

interface OpenSession {
  startedAt: number;
  lastTickAt: number;
  activeMs: number;
  pagesRead: number;
  emittedMs: number;
  emittedPages: number;
}

/**
 * Pure reading-time state machine. The caller supplies the clock and a tick
 * every 30 seconds; nothing here touches timers, storage or the DOM.
 *
 * Counting rules:
 * - only while the reader is visible and the window is focused;
 * - at most until two minutes after the last user activity;
 * - a session closes at that two-minute boundary, and a new one starts on the
 *   next activity, so a session can never span an idle period;
 * - a session is also closed after thirty minutes of accumulated reading and
 *   immediately reopened when the reader is still active.
 */
export function createReadingClock(options: ReadingClockOptions = {}): ReadingClock {
  const now = options.now ?? (() => Date.now());
  const idleMs = options.idleMs ?? READING_IDLE_PAUSE_SECONDS * 1_000;
  const maxSegmentMs = options.maxSegmentMs ?? READING_SESSION_MAX_SEGMENT_SECONDS * 1_000;

  let visible = true;
  let focused = true;
  let lastActivityAt: number | null = null;
  let session: OpenSession | null = null;

  function canCount(at: number): boolean {
    return (
      session !== null &&
      visible &&
      focused &&
      lastActivityAt !== null &&
      at - lastActivityAt <= idleMs
    );
  }

  function snapshotOf(at: number): ReadingSessionSnapshot {
    const open = session!;
    return {
      startedAt: open.startedAt,
      endedAt: Math.max(open.startedAt, at),
      activeSeconds: Math.round(open.activeMs / 1_000),
      pagesRead: open.pagesRead,
    };
  }

  function startSession(at: number): void {
    session = {
      startedAt: at,
      lastTickAt: at,
      activeMs: 0,
      pagesRead: 0,
      emittedMs: 0,
      emittedPages: 0,
    };
  }

  function resetSession(): void {
    session = null;
  }

  function recordActivity(at: number): void {
    const previous = lastActivityAt;
    lastActivityAt = at;
    if (session === null) {
      if (visible && focused) {
        startSession(at);
      }
      return;
    }
    // Resuming after the idle window must not backfill the quiet gap.
    if (previous === null || at - previous >= idleMs) {
      session.lastTickAt = at;
    }
    if (!visible || !focused) {
      session.lastTickAt = at;
    }
  }

  return {
    activity(at = now()) {
      recordActivity(at);
    },

    pageTurn(at = now()) {
      recordActivity(at);
      if (session !== null) {
        session.pagesRead += 1;
      }
    },

    setVisible(value, at = now()) {
      visible = value;
      if (session !== null) {
        // Both directions skip the interval where the reader could not count.
        session.lastTickAt = at;
      }
    },

    setFocused(value, at = now()) {
      focused = value;
      if (session !== null) {
        session.lastTickAt = at;
      }
    },

    tick(at = now()) {
      if (session === null) {
        return {};
      }

      if (canCount(at)) {
        const boundary = (lastActivityAt ?? at) + idleMs;
        const countedUntil = Math.min(at, boundary);
        // `lastTickAt` may sit in the future when the clock was adjusted.
        session.activeMs += Math.max(0, countedUntil - session.lastTickAt);
      }
      session.lastTickAt = at;

      const idle = lastActivityAt !== null && at - lastActivityAt >= idleMs;
      const fullSegment = session.activeMs >= maxSegmentMs;

      if (idle || fullSegment) {
        const endedAt = idle
          ? (lastActivityAt ?? at) + idleMs
          : at;
        const closed = snapshotOf(endedAt);
        resetSession();
        if (fullSegment && !idle && visible && focused) {
          startSession(at);
        }
        return closed.activeSeconds > 0 ? { closed } : {};
      }

      const changed =
        session.activeMs !== session.emittedMs || session.pagesRead !== session.emittedPages;
      if (!changed) {
        return {};
      }
      session.emittedMs = session.activeMs;
      session.emittedPages = session.pagesRead;
      return { snapshot: snapshotOf(at) };
    },

    close(at = now()) {
      if (session === null) {
        return null;
      }
      // Include the time since the last tick; unload paths call `close`
      // directly and must not lose up to thirty seconds of reading.
      if (canCount(at)) {
        const boundary = (lastActivityAt ?? at) + idleMs;
        session.activeMs += Math.max(0, Math.min(at, boundary) - session.lastTickAt);
      }
      const snapshot = snapshotOf(at);
      resetSession();
      return snapshot.activeSeconds > 0 ? snapshot : null;
    },

    isActive(at = now()) {
      return canCount(at);
    },

    current(at = now()) {
      return session === null ? null : snapshotOf(at);
    },
  };
}
