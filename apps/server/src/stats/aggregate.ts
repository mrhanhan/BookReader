import { EFFECTIVE_READING_SECONDS } from '@bookr/shared';
import type { Database, Transaction } from '../db/client';
import type { ReadingSessionRow } from '../db/schema';
import {
  deleteAllDailyStats,
  deleteDailyStat,
  listAllSessions,
  listSessionsOverlapping,
  replaceDailyStat,
} from './repo';
import { addLocalDays, localDateOf, localDayEnd, localDayStart } from './time';

/** Upper bound when walking the local dates a session touches. */
const MAX_SESSION_DATES = 25;

/**
 * Local calendar dates touched by `[startedAt, endedAt]`, inclusive and in
 * ascending order. A session may only span two dates in practice; the cap
 * keeps a malformed range from turning into an unbounded loop.
 */
export function sessionLocalDates(
  startedAt: Date,
  endedAt: Date,
  timezone: string,
): string[] {
  const first = localDateOf(startedAt, timezone);
  const last = localDateOf(endedAt < startedAt ? startedAt : endedAt, timezone);
  const dates = [first];
  let cursor = first;
  for (let step = 0; step < MAX_SESSION_DATES && cursor !== last; step += 1) {
    cursor = addLocalDays(cursor, 1);
    dates.push(cursor);
    if (cursor > last) {
      // Clock corrections can briefly make the end date sort before the start
      // date; trust the start date and stop instead of walking forever.
      break;
    }
  }
  return dates;
}

/**
 * The share of a session's active seconds that belongs to one local date.
 * Active time is apportioned by wall-clock overlap, so a session crossing
 * midnight splits in proportion to the time spent on each side.
 */
export function splitSessionSeconds(
  row: Pick<ReadingSessionRow, 'startedAt' | 'endedAt' | 'activeSeconds'>,
  localDate: string,
  timezone: string,
): number {
  const started = row.startedAt.getTime();
  const ended = row.endedAt.getTime();
  if (ended <= started) {
    return localDateOf(row.startedAt, timezone) === localDate ? row.activeSeconds : 0;
  }

  const dayStart = localDayStart(localDate, timezone).getTime();
  const dayEnd = localDayEnd(localDate, timezone).getTime();
  const overlap = Math.max(0, Math.min(ended, dayEnd) - Math.max(started, dayStart));
  if (overlap === 0) {
    return 0;
  }
  return Math.round((row.activeSeconds * overlap) / (ended - started));
}

/**
 * Recomputes the aggregate for the given local dates from raw sessions. The
 * aggregate is a pure function of the sessions, so a replay never doubles a
 * day; a day that no longer carries active time is removed.
 */
export async function recomputeDailyStats(
  tx: Transaction,
  userId: string,
  timezone: string,
  dates: string[],
  now: Date = new Date(),
): Promise<void> {
  const wanted = [...new Set(dates)].sort();
  if (wanted.length === 0) {
    return;
  }

  const first = wanted[0]!;
  const last = wanted[wanted.length - 1]!;
  const sessions = await listSessionsOverlapping(
    tx,
    userId,
    localDayStart(first, timezone),
    localDayEnd(last, timezone),
  );

  for (const localDate of wanted) {
    let activeSeconds = 0;
    for (const session of sessions) {
      activeSeconds += splitSessionSeconds(session, localDate, timezone);
    }
    if (activeSeconds <= 0) {
      await deleteDailyStat(tx, userId, localDate);
      continue;
    }
    await replaceDailyStat(tx, {
      userId,
      localDate,
      activeSeconds,
      qualified: activeSeconds >= EFFECTIVE_READING_SECONDS,
      updatedAt: now,
    });
  }
}

/**
 * Rebuilds every aggregated day for one user in the given timezone. Used when
 * the user changes timezones: the same sessions must be re-bucketed without
 * losing or double-counting a second.
 */
export async function rebuildDailyStats(
  db: Database,
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<void> {
  await db.transaction(async (tx) => {
    await deleteAllDailyStats(tx, userId);
    const sessions = await listAllSessions(tx, userId);
    const dates = new Set<string>();
    for (const session of sessions) {
      for (const localDate of sessionLocalDates(session.startedAt, session.endedAt, timezone)) {
        dates.add(localDate);
      }
    }
    await recomputeDailyStats(tx, userId, timezone, [...dates], now);
  });
}
