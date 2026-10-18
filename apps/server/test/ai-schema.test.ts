import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { aiMessages, aiThreads, users } from '../src/db/schema';
import { resetDb, seedBook, seedUser, testDb } from './helpers';

it('stores AI threads and cascades messages with the thread', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });

  const [thread] = await testDb.insert(aiThreads).values({
    userId: user.id,
    bookId: book.id,
    title: '解释一段话',
    anchorLocator: { kind: 'pdf', page: 2, percent: 0.2 },
  }).returning();
  await testDb.insert(aiMessages).values({
    threadId: thread!.id,
    role: 'user',
    content: '为什么要这样写？',
    status: 'complete',
  });

  await testDb.delete(aiThreads).where(eq(aiThreads.id, thread!.id));
  expect(await testDb.select().from(aiMessages)).toHaveLength(0);
});

it('gives new accounts the default AI quotas', async () => {
  await resetDb();
  const user = await seedUser('member');
  const [row] = await testDb.select({
    daily: users.aiDailyTokenLimit,
    monthly: users.aiMonthlyTokenLimit,
  }).from(users).where(eq(users.id, user.id));
  expect(row).toEqual({ daily: 100_000, monthly: 1_000_000 });
});
