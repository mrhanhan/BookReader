import { newId } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import type { AppDeps } from '../src/app';
import { books, dailyStats, readingSessions, users } from '../src/db/schema';
import { getReadingStats } from '../src/stats/service';
import { createTestApp, resetDb, seedBook, seedUser, testDb } from './helpers';

/** 2026-10-21 12:00 in Shanghai (Wednesday). */
const NOW = new Date('2026-10-21T04:00:00.000Z');
const TODAY = '2026-10-21';

let deps: AppDeps;
let userId: string;

beforeEach(async () => {
  await resetDb();
  const user = await seedUser('member');
  userId = user.id;
  const built = await createTestApp();
  deps = { ...built.deps, clock: { now: () => NOW } };
});

async function seedDay(localDate: string, activeSeconds: number): Promise<void> {
  await testDb.insert(dailyStats).values({
    userId,
    localDate,
    activeSeconds,
    qualified: activeSeconds >= 600,
    updatedAt: NOW,
  });
}

async function seedSession(bookId: string, activeSeconds: number): Promise<void> {
  const endedAt = new Date(NOW);
  const startedAt = new Date(NOW.getTime() - activeSeconds * 1_000);
  await testDb.insert(readingSessions).values({
    id: newId(),
    userId,
    bookId,
    startedAt,
    endedAt,
    activeSeconds,
    pagesRead: 1,
    clientUpdatedAt: NOW,
    updatedAt: NOW,
  });
}

it('returns an empty but well-shaped payload without activity', async () => {
  const stats = await getReadingStats(deps, userId);

  expect(stats).toMatchObject({
    timezone: 'Asia/Shanghai',
    today: TODAY,
    streakDays: 0,
    effectiveDays: 0,
    todaySeconds: 0,
    weekSeconds: 0,
    monthSeconds: 0,
    finishedBooks: 0,
    topBook: null,
  });
  expect(stats.daily).toHaveLength(30);
  expect(stats.daily.at(-1)).toEqual({ date: TODAY, activeSeconds: 0, qualified: false });
  expect(stats.daily[0]?.date).toBe('2026-09-22');
});

it('windows daily, week and month sums to the current local calendar', async () => {
  await seedDay('2026-09-29', 300);
  await seedDay('2026-09-30', 5_000);
  await seedDay('2026-10-18', 400);
  await seedDay('2026-10-19', 700);
  await seedDay('2026-10-20', 650);
  await seedDay(TODAY, 600);
  await seedDay('2026-10-22', 9_999);

  const stats = await getReadingStats(deps, userId);

  expect(stats.todaySeconds).toBe(600);
  // Week starts Monday 2026-10-19.
  expect(stats.weekSeconds).toBe(700 + 650 + 600);
  // Month starts 2026-10-01; 2026-09-30 stays out even though it is qualified.
  expect(stats.monthSeconds).toBe(400 + 700 + 650 + 600);
  expect(stats.effectiveDays).toBe(4);
  expect(stats.daily).toHaveLength(30);
  expect(stats.daily.at(-1)?.date).toBe(TODAY);
  // Future rows never leak into the chart.
  expect(stats.daily.some((day) => day.date === '2026-10-22')).toBe(false);
  expect(stats.daily.find((day) => day.date === '2026-10-18')?.activeSeconds).toBe(400);
});

it('counts a streak ending today when today is qualified', async () => {
  await seedDay('2026-10-19', 700);
  await seedDay('2026-10-20', 650);
  await seedDay(TODAY, 600);
  expect((await getReadingStats(deps, userId)).streakDays).toBe(3);
});

it('falls back to yesterday when today has not qualified yet', async () => {
  await seedDay('2026-10-19', 700);
  await seedDay('2026-10-20', 650);
  await seedDay(TODAY, 300);
  expect((await getReadingStats(deps, userId)).streakDays).toBe(2);
});

it('reports zero when neither today nor yesterday qualified', async () => {
  await seedDay('2026-10-19', 700);
  await seedDay('2026-10-20', 300);
  await seedDay(TODAY, 200);
  expect((await getReadingStats(deps, userId)).streakDays).toBe(0);
});

it('stops the streak at a missing day', async () => {
  await seedDay('2026-10-19', 700);
  await seedDay(TODAY, 600);
  expect((await getReadingStats(deps, userId)).streakDays).toBe(1);
});

it('picks the most-read live book and ignores trashed books', async () => {
  const tiny = await seedBook({ uploadedBy: userId, title: '小书', author: '甲' });
  const big = await seedBook({ uploadedBy: userId, title: '大书', author: '乙' });
  const trashed = await seedBook({
    uploadedBy: userId,
    title: '回收站里的书',
    deletedAt: NOW,
  });
  await seedSession(tiny.id, 600);
  await seedSession(big.id, 2_400);
  await seedSession(trashed.id, 9_999);

  const stats = await getReadingStats(deps, userId);
  expect(stats.topBook).toEqual({
    id: big.id,
    title: '大书',
    author: '乙',
    activeSeconds: 2_400,
  });
});

it('counts only live books marked finished on the shared shelf', async () => {
  await seedBook({ uploadedBy: userId, status: 'finished' });
  await seedBook({ uploadedBy: userId, status: 'finished' });
  await seedBook({ uploadedBy: userId, status: 'reading' });
  await seedBook({ uploadedBy: userId, status: 'finished', deletedAt: NOW });

  expect((await getReadingStats(deps, userId)).finishedBooks).toBe(2);
});

it('moves the local date boundary with the user timezone', async () => {
  await seedDay('2026-10-20', 900);
  await seedDay('2026-10-21', 600);

  const shanghai = await getReadingStats(deps, userId);
  expect(shanghai.today).toBe('2026-10-21');
  expect(shanghai.todaySeconds).toBe(600);
  expect(shanghai.streakDays).toBe(2);

  // 2026-10-21T02:00Z is still 2026-10-20 in New York.
  const nyDeps: AppDeps = { ...deps, clock: { now: () => new Date('2026-10-21T02:00:00.000Z') } };
  await testDb.update(users).set({ timezone: 'America/New_York' }).where(eq(users.id, userId));
  const newYork = await getReadingStats(nyDeps, userId);

  expect(newYork.timezone).toBe('America/New_York');
  expect(newYork.today).toBe('2026-10-20');
  expect(newYork.todaySeconds).toBe(900);
  // Only the 20th qualifies in New York's window.
  expect(newYork.streakDays).toBe(1);
});

it('keeps one user out of another user statistics', async () => {
  const other = await seedUser('member');
  await testDb.insert(readingSessions).values({
    id: newId(),
    userId: other.id,
    bookId: (await seedBook({ uploadedBy: other.id })).id,
    startedAt: new Date(NOW.getTime() - 3_600_000),
    endedAt: NOW,
    activeSeconds: 3_600,
    pagesRead: 1,
    clientUpdatedAt: NOW,
    updatedAt: NOW,
  });
  await testDb.insert(dailyStats).values({
    userId: other.id,
    localDate: TODAY,
    activeSeconds: 3_600,
    qualified: true,
    updatedAt: NOW,
  });

  const stats = await getReadingStats(deps, userId);
  expect(stats.effectiveDays).toBe(0);
  expect(stats.todaySeconds).toBe(0);
  expect(stats.topBook).toBeNull();
});
