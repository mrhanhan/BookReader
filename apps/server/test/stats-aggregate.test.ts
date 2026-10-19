import { newId } from '@bookr/shared';
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { dailyStats, readingSessions } from '../src/db/schema';
import {
  rebuildDailyStats,
  recomputeDailyStats,
  sessionLocalDates,
  splitSessionSeconds,
} from '../src/stats/aggregate';
import { resetDb, seedBook, seedUser, testDb } from './helpers';

let userId: string;
let bookId: string;

beforeEach(async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  userId = user.id;
  bookId = book.id;
});

async function insertSession(input: {
  startedAt: string;
  endedAt: string;
  activeSeconds: number;
}): Promise<void> {
  await testDb.insert(readingSessions).values({
    id: newId(),
    userId,
    bookId,
    startedAt: new Date(input.startedAt),
    endedAt: new Date(input.endedAt),
    activeSeconds: input.activeSeconds,
    pagesRead: 3,
    clientUpdatedAt: new Date(input.endedAt),
    updatedAt: new Date(input.endedAt),
  });
}

async function statFor(localDate: string) {
  const [row] = await testDb
    .select()
    .from(dailyStats)
    .where(and(eq(dailyStats.userId, userId), eq(dailyStats.localDate, localDate)));
  return row;
}

const MIDNIGHT = {
  startedAt: '2026-10-18T15:50:00.000Z',
  endedAt: '2026-10-18T16:20:00.000Z',
  activeSeconds: 1_500,
};

it('splits a session that crosses local midnight by wall-clock overlap', async () => {
  const row = {
    startedAt: new Date(MIDNIGHT.startedAt),
    endedAt: new Date(MIDNIGHT.endedAt),
    activeSeconds: MIDNIGHT.activeSeconds,
  };

  expect(sessionLocalDates(row.startedAt, row.endedAt, 'Asia/Shanghai')).toEqual([
    '2026-10-18',
    '2026-10-19',
  ]);
  expect(splitSessionSeconds(row, '2026-10-18', 'Asia/Shanghai')).toBe(500);
  expect(splitSessionSeconds(row, '2026-10-19', 'Asia/Shanghai')).toBe(1_000);

  await insertSession(MIDNIGHT);
  await testDb.transaction(async (tx) => {
    await recomputeDailyStats(tx, userId, 'Asia/Shanghai', ['2026-10-18', '2026-10-19']);
  });

  expect((await statFor('2026-10-18'))?.activeSeconds).toBe(500);
  expect((await statFor('2026-10-18'))?.qualified).toBe(false);
  expect((await statFor('2026-10-19'))?.activeSeconds).toBe(1_000);
  expect((await statFor('2026-10-19'))?.qualified).toBe(true);
});

it('attributes a zero-length session to its start date', async () => {
  const startedAt = new Date('2026-10-19T04:00:00.000Z');
  const row = { startedAt, endedAt: startedAt, activeSeconds: 120 };
  expect(splitSessionSeconds(row, '2026-10-19', 'Asia/Shanghai')).toBe(120);
  expect(splitSessionSeconds(row, '2026-10-18', 'Asia/Shanghai')).toBe(0);
});

it('counts a zero-length session sitting exactly on local midnight', async () => {
  // 2026-10-19T16:00Z is exactly 2026-10-20 00:00 in Shanghai.
  await insertSession({
    startedAt: '2026-10-19T16:00:00.000Z',
    endedAt: '2026-10-19T16:00:00.000Z',
    activeSeconds: 90,
  });
  await testDb.transaction(async (tx) => {
    await recomputeDailyStats(tx, userId, 'Asia/Shanghai', ['2026-10-20']);
  });

  expect((await statFor('2026-10-20'))?.activeSeconds).toBe(90);
});

it('qualifies a day at exactly ten minutes and not a second less', async () => {
  await insertSession({
    startedAt: '2026-10-17T02:00:00.000Z',
    endedAt: '2026-10-17T02:10:00.000Z',
    activeSeconds: 600,
  });
  await insertSession({
    startedAt: '2026-10-18T02:00:00.000Z',
    endedAt: '2026-10-18T02:10:00.000Z',
    activeSeconds: 599,
  });
  await testDb.transaction(async (tx) => {
    await recomputeDailyStats(tx, userId, 'Asia/Shanghai', ['2026-10-17', '2026-10-18']);
  });

  expect((await statFor('2026-10-17'))?.qualified).toBe(true);
  expect((await statFor('2026-10-18'))?.qualified).toBe(false);
});

it('re-buckets the same sessions into another timezone without losing seconds', async () => {
  await insertSession({
    startedAt: '2026-10-19T00:30:00.000Z',
    endedAt: '2026-10-19T02:30:00.000Z',
    activeSeconds: 7_200,
  });
  await insertSession({
    startedAt: '2026-10-19T01:30:00.000Z',
    endedAt: '2026-10-19T02:30:00.000Z',
    activeSeconds: 3_600,
  });

  await rebuildDailyStats(testDb, userId, 'Asia/Shanghai');
  const shanghai = await testDb
    .select()
    .from(dailyStats)
    .where(eq(dailyStats.userId, userId));
  expect(shanghai.reduce((sum, row) => sum + row.activeSeconds, 0)).toBe(10_800);
  expect(shanghai.map((row) => row.localDate)).toEqual(['2026-10-19']);

  await rebuildDailyStats(testDb, userId, 'America/New_York');
  const newYork = await testDb
    .select()
    .from(dailyStats)
    .where(eq(dailyStats.userId, userId));
  expect(newYork.reduce((sum, row) => sum + row.activeSeconds, 0)).toBe(10_800);
  expect(newYork.map((row) => row.localDate)).toEqual(['2026-10-18']);
});

it('uses the real DST day boundary when a session crosses midnight', async () => {
  // New York: 2026-03-08 23:30 EDT through 2026-03-09 00:30 EDT.
  await insertSession({
    startedAt: '2026-03-09T03:30:00.000Z',
    endedAt: '2026-03-09T04:30:00.000Z',
    activeSeconds: 3_600,
  });
  await testDb.transaction(async (tx) => {
    await recomputeDailyStats(tx, userId, 'America/New_York', ['2026-03-08', '2026-03-09']);
  });

  expect((await statFor('2026-03-08'))?.activeSeconds).toBe(1_800);
  expect((await statFor('2026-03-09'))?.activeSeconds).toBe(1_800);
});

it('handles the 25-hour Berlin day around the DST end', async () => {
  // Berlin: 2026-10-25 23:30 CET through 2026-10-26 00:30 CET; local midnight
  // of the 26th is 2026-10-25T23:00Z because the 25th is 25 hours long.
  await insertSession({
    startedAt: '2026-10-25T22:30:00.000Z',
    endedAt: '2026-10-25T23:30:00.000Z',
    activeSeconds: 3_600,
  });
  await testDb.transaction(async (tx) => {
    await recomputeDailyStats(tx, userId, 'Europe/Berlin', ['2026-10-25', '2026-10-26']);
  });

  expect((await statFor('2026-10-25'))?.activeSeconds).toBe(1_800);
  expect((await statFor('2026-10-26'))?.activeSeconds).toBe(1_800);
});
