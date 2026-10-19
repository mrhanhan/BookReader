import { newId } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { dailyStats, readingSessions, users } from '../src/db/schema';
import {
  authHeader,
  buildTestApp,
  resetDb,
  seedBook,
  seedUser,
  testDb,
  type SeededUser,
} from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');

let app: FastifyInstance;
let user: SeededUser;
let bookId: string;

beforeEach(async () => {
  await resetDb();
  app = await buildTestApp();
  user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  bookId = book.id;
});

async function patch(body: unknown, headers = true) {
  return app.inject({
    method: 'PATCH',
    url: '/api/auth/me',
    headers: headers ? await authHeader(user) : {},
    payload: body as Record<string, unknown>,
  });
}

it('requires authentication', async () => {
  const response = await patch({ timezone: 'UTC' }, false);
  expect(response.statusCode).toBe(401);
});

it('rejects an invalid or blank timezone', async () => {
  for (const timezone of ['', '   ', 'Mars/Olympus', '+08:00', 'x'.repeat(65)]) {
    const response = await patch({ timezone });
    expect(response.statusCode, timezone).toBe(400);
    expect(response.json().error.code).toBe('VALIDATION_FAILED');
  }
});

it('stores a valid timezone and returns it', async () => {
  const response = await patch({ timezone: ' America/New_York ' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ timezone: 'America/New_York' });

  const [stored] = await testDb
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, user.id));
  expect(stored?.timezone).toBe('America/New_York');
});

it('rebuilds daily aggregates in the new timezone', async () => {
  await testDb.insert(readingSessions).values({
    id: newId(),
    userId: user.id,
    bookId,
    // 2026-10-19 08:30–10:30 in Shanghai, 2026-10-18 20:30–22:30 in New York.
    startedAt: new Date('2026-10-19T00:30:00.000Z'),
    endedAt: new Date('2026-10-19T02:30:00.000Z'),
    activeSeconds: 7_200,
    pagesRead: 5,
    clientUpdatedAt: NOW,
    updatedAt: NOW,
  });
  // Aggregate as the previous timezone left it.
  await testDb.insert(dailyStats).values({
    userId: user.id,
    localDate: '2026-10-19',
    activeSeconds: 7_200,
    qualified: true,
    updatedAt: NOW,
  });

  const response = await patch({ timezone: 'America/New_York' });
  expect(response.statusCode).toBe(200);

  const rows = await testDb
    .select()
    .from(dailyStats)
    .where(eq(dailyStats.userId, user.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({
    localDate: '2026-10-18',
    activeSeconds: 7_200,
    qualified: true,
  });
  expect(rows.reduce((sum, row) => sum + row.activeSeconds, 0)).toBe(7_200);
});
