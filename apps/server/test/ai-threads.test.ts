import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { aiMessages, aiThreads, aiUsage, books } from '../src/db/schema';
import { periodKeys } from '../src/ai/quota';
import {
  authHeader, createTestApp, resetDb, seedBook, seedUser, testDb,
} from './helpers';

async function seedThread(userId: string, bookId: string) {
  const [thread] = await testDb.insert(aiThreads).values({
    userId, bookId, title: '解释一段话',
    anchorLocator: { kind: 'pdf', page: 2, percent: 0.2 },
  }).returning();
  await testDb.insert(aiMessages).values([
    { threadId: thread!.id, role: 'user', content: '为什么？', action: 'ask', status: 'complete' },
    { threadId: thread!.id, role: 'assistant', content: '因为……', status: 'complete' },
  ]);
  return thread!;
}

it('lists, reads and deletes only the caller\'s threads', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const owner = await seedUser('member');
  const other = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf' });
  const thread = await seedThread(owner.id, book.id);

  const list = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/ai/threads`, headers: await authHeader(owner),
  });
  expect(list.statusCode).toBe(200);
  expect(list.json().items).toMatchObject([{ id: thread.id, messageCount: 2 }]);

  const detail = await app.inject({
    method: 'GET', url: `/api/ai/threads/${thread.id}`, headers: await authHeader(owner),
  });
  expect(detail.statusCode).toBe(200);
  expect(detail.json().messages.map((message: { role: string }) => message.role))
    .toEqual(['user', 'assistant']);

  const otherHeaders = await authHeader(other);
  expect((await app.inject({ method: 'GET', url: `/api/ai/threads/${thread.id}`, headers: otherHeaders })).statusCode)
    .toBe(404);
  expect((await app.inject({ method: 'DELETE', url: `/api/ai/threads/${thread.id}`, headers: otherHeaders })).statusCode)
    .toBe(404);
  expect((await app.inject({ method: 'GET', url: `/api/books/${book.id}/ai/threads`, headers: otherHeaders })).json().items)
    .toEqual([]);

  expect((await app.inject({ method: 'DELETE', url: `/api/ai/threads/${thread.id}`, headers: await authHeader(owner) })).statusCode)
    .toBe(204);
  expect(await testDb.select().from(aiMessages)).toHaveLength(0);
});


it('reports usage, enablement and configuration', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const user = await seedUser('member');
  const headers = await authHeader(user);
  const keys = periodKeys(new Date(), 'Asia/Shanghai');
  await testDb.insert(aiUsage).values({
    userId: user.id, period: 'day', periodStart: keys.day,
    promptTokens: 1_000, completionTokens: 234,
  });

  const usage = await app.inject({ method: 'GET', url: '/api/ai/usage', headers });
  expect(usage.statusCode).toBe(200);
  expect(usage.json()).toMatchObject({
    enabled: true,
    configured: false,
    model: null,
    daily: { used: 1_234, reserved: 0, limit: 100_000 },
    monthly: { limit: 1_000_000 },
  });

  const toggled = await app.inject({
    method: 'PATCH', url: '/api/me/ai', headers, payload: { enabled: false },
  });
  expect(toggled.json()).toEqual({ enabled: false });
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers });
  expect(me.json().aiEnabled).toBe(false);
});

it('refuses threads for a book that is gone', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  await testDb.update(books).set({ deletedAt: new Date() }).where(eq(books.id, book.id));

  const response = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/ai/threads`, headers: await authHeader(user),
  });
  expect(response.statusCode).toBe(404);
});
