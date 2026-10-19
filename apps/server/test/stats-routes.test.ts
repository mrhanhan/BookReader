import { newId } from '@bookr/shared';
import { expect, it } from 'vitest';
import { dailyStats, readingSessions } from '../src/db/schema';
import {
  authHeader,
  buildTestApp,
  createTestApp,
  resetDb,
  seedBook,
  seedUser,
  testDb,
} from './helpers';

const NOW = new Date('2026-10-21T04:00:00.000Z');

it('requires authentication', async () => {
  await resetDb();
  const app = await buildTestApp();
  const response = await app.inject({ method: 'GET', url: '/api/stats' });
  expect(response.statusCode).toBe(401);
});

it('returns the caller payload with thirty ordered days', async () => {
  await resetDb();
  const { app, deps } = await createTestApp();
  deps.clock.now = () => NOW;
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, title: '统计之书' });
  const endedAt = new Date(NOW);
  await testDb.insert(readingSessions).values({
    id: newId(),
    userId: user.id,
    bookId: book.id,
    startedAt: new Date(NOW.getTime() - 1_200_000),
    endedAt,
    activeSeconds: 1_200,
    pagesRead: 2,
    clientUpdatedAt: NOW,
    updatedAt: NOW,
  });
  await testDb.insert(dailyStats).values({
    userId: user.id,
    localDate: '2026-10-21',
    activeSeconds: 1_200,
    qualified: true,
    updatedAt: NOW,
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/stats',
    headers: await authHeader(user),
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body).toMatchObject({
    timezone: 'Asia/Shanghai',
    streakDays: 1,
    effectiveDays: 1,
    todaySeconds: 1_200,
    topBook: { id: book.id, title: '统计之书', activeSeconds: 1_200 },
  });
  expect(body.daily).toHaveLength(30);
  const dates = body.daily.map((day: { date: string }) => day.date);
  expect(dates).toEqual([...dates].sort());
  expect(dates.at(-1)).toBe('2026-10-21');
});

it('never exposes another user statistics', async () => {
  await resetDb();
  const { app, deps } = await createTestApp();
  deps.clock.now = () => NOW;
  const owner = await seedUser('member');
  const viewer = await seedUser('member');
  await testDb.insert(dailyStats).values({
    userId: owner.id,
    localDate: '2026-10-21',
    activeSeconds: 3_600,
    qualified: true,
    updatedAt: NOW,
  });

  const response = await app.inject({
    method: 'GET',
    url: '/api/stats',
    headers: await authHeader(viewer),
  });

  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({
    streakDays: 0,
    effectiveDays: 0,
    todaySeconds: 0,
  });
});
