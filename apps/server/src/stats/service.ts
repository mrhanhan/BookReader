import {
  STATS_DAILY_DAYS,
  type DailyReadingStatDto,
  type ReadingStatsDto,
  type TopBookStatDto,
} from '@bookr/shared';
import { and, asc, desc, eq, isNull, sql } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { books, dailyStats, readingSessions, users } from '../db/schema';
import { addLocalDays, localDateOf, startOfLocalMonth, startOfLocalWeek } from './time';

const DEFAULT_TIMEZONE = 'Asia/Shanghai';

async function readTimezone(deps: AppDeps, userId: string): Promise<string> {
  const [row] = await deps.db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.timezone?.trim() || DEFAULT_TIMEZONE;
}

/** Counts qualified days ending at `anchor`, walking back one local day at a time. */
function streakFrom(anchor: string, qualified: Set<string>): number {
  let days = 0;
  let cursor = anchor;
  while (qualified.has(cursor)) {
    days += 1;
    cursor = addLocalDays(cursor, -1);
  }
  return days;
}

async function readTopBook(deps: AppDeps, userId: string): Promise<TopBookStatDto | null> {
  const total = sql<number>`sum(${readingSessions.activeSeconds})`;
  const [row] = await deps.db
    .select({
      id: books.id,
      title: books.title,
      author: books.author,
      activeSeconds: sql<number>`${total}::int`,
    })
    .from(readingSessions)
    .innerJoin(books, eq(books.id, readingSessions.bookId))
    .where(and(eq(readingSessions.userId, userId), isNull(books.deletedAt)))
    .groupBy(books.id, books.title, books.author)
    .orderBy(desc(total))
    .limit(1);
  return row ?? null;
}

/**
 * Builds the statistics page payload. The aggregate is read as-is: maintenance
 * happens when sessions are written, so this path never writes.
 */
export async function getReadingStats(
  deps: AppDeps,
  userId: string,
): Promise<ReadingStatsDto> {
  const timezone = await readTimezone(deps, userId);
  const today = localDateOf(deps.clock.now(), timezone);
  const windowStart = addLocalDays(today, -(STATS_DAILY_DAYS - 1));
  const weekStart = startOfLocalWeek(today);
  const monthStart = startOfLocalMonth(today);

  const rows = await deps.db
    .select({
      localDate: dailyStats.localDate,
      activeSeconds: dailyStats.activeSeconds,
      qualified: dailyStats.qualified,
    })
    .from(dailyStats)
    .where(eq(dailyStats.userId, userId))
    .orderBy(asc(dailyStats.localDate));
  const byDate = new Map(rows.map((row) => [row.localDate, row]));

  const daily: DailyReadingStatDto[] = [];
  for (let offset = 0; offset < STATS_DAILY_DAYS; offset += 1) {
    const date = addLocalDays(windowStart, offset);
    const row = byDate.get(date);
    daily.push({
      date,
      activeSeconds: row?.activeSeconds ?? 0,
      qualified: row?.qualified ?? false,
    });
  }

  let effectiveDays = 0;
  let weekSeconds = 0;
  let monthSeconds = 0;
  const qualified = new Set<string>();
  for (const row of rows) {
    // A clock-skewed or future-dated session must not inflate history.
    if (row.localDate > today) {
      continue;
    }
    if (row.qualified) {
      effectiveDays += 1;
      qualified.add(row.localDate);
    }
    if (row.localDate >= weekStart && row.localDate <= today) {
      weekSeconds += row.activeSeconds;
    }
    if (row.localDate >= monthStart && row.localDate <= today) {
      monthSeconds += row.activeSeconds;
    }
  }

  const anchor = qualified.has(today) ? today : addLocalDays(today, -1);
  const streakDays = streakFrom(anchor, qualified);

  const [finished] = await deps.db
    .select({ total: sql<number>`count(*)::int` })
    .from(books)
    .where(and(eq(books.status, 'finished'), isNull(books.deletedAt)));

  return {
    timezone,
    today,
    streakDays,
    effectiveDays,
    todaySeconds: byDate.get(today)?.activeSeconds ?? 0,
    weekSeconds,
    monthSeconds,
    finishedBooks: finished?.total ?? 0,
    topBook: await readTopBook(deps, userId),
    daily,
  };
}
