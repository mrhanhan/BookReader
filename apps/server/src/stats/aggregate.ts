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
 * Splits a session across the local dates it touches. Early dates receive the
 * floored proportional share and the last date carries the remainder, so the
 * shares always add back up to `activeSeconds` exactly (no second is invented
 * or lost at midnight).
 */
export function sessionShares(
  row: Pick<ReadingSessionRow, 'startedAt' | 'endedAt' | 'activeSeconds'>,
  timezone: string,
): Map<string, number> {
  const shares = new Map<string, number>();
  const started = row.startedAt.getTime();
  const ended = row.endedAt.getTime();
  if (ended <= started) {
    shares.set(localDateOf(row.startedAt, timezone), row.activeSeconds);
    return shares;
  }

  const dates = sessionLocalDates(row.startedAt, row.endedAt, timezone);
  const weights = dates.map((date) =>
    Math.max(
      0,
      Math.min(ended, localDayEnd(date, timezone).getTime()) -
        Math.max(started, localDayStart(date, timezone).getTime()),
    ),
  );
  const totalWeight = weights.reduce((total, weight) => total + weight, 0);
  if (totalWeight === 0) {
    shares.set(localDateOf(row.startedAt, timezone), row.activeSeconds);
    return shares;
  }

  let assigned = 0;
  dates.forEach((date, index) => {
    const share =
      index === dates.length - 1
        ? row.activeSeconds - assigned
        : Math.floor((row.activeSeconds * weights[index]!) / totalWeight);
    assigned += share;
    shares.set(date, share);
  });
  return shares;
}

/** The share of a session's active seconds that belongs to one local date. */
export function splitSessionSeconds(
  row: Pick<ReadingSessionRow, 'startedAt' | 'endedAt' | 'activeSeconds'>,
  localDate: string,
  timezone: string,
): number {
  return sessionShares(row, timezone).get(localDate) ?? 0;
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

  const sharesBySession = sessions.map((session) => sessionShares(session, timezone));

  for (const localDate of wanted) {
    let activeSeconds = 0;
    for (const shares of sharesBySession) {
      activeSeconds += shares.get(localDate) ?? 0;
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
 * Rebuilds every aggregated day inside a caller-owned transaction, so a
 * timezone change and its re-bucketing commit atomically.
 */
export async function rebuildDailyStatsInTransaction(
  tx: Transaction,
  userId: string,
  timezone: string,
  now: Date = new Date(),
): Promise<void> {
  await deleteAllDailyStats(tx, userId);
  const sessions = await listAllSessions(tx, userId);
  const dates = new Set<string>();
  for (const session of sessions) {
    for (const localDate of sessionLocalDates(session.startedAt, session.endedAt, timezone)) {
      dates.add(localDate);
    }
  }
  await recomputeDailyStats(tx, userId, timezone, [...dates], now);
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
    await rebuildDailyStatsInTransaction(tx, userId, timezone, now);
  });
}
