import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { FakeAiClient } from '../src/ai/fake';
import { aiMessages, aiThreads, aiUsage, books, users } from '../src/db/schema';
import {
  authHeader,
  buildTestConfig,
  createTestApp,
  resetDb,
  seedBook,
  seedUser,
  testDb,
} from './helpers';

interface SseEvent {
  event: string;
  data: Record<string, unknown>;
}

function parseFrames(text: string): SseEvent[] {
  return text
    .split('\n\n')
    .filter((frame) => frame.trim().length > 0)
    .map((frame) => {
      const lines = frame.split('\n');
      const event = lines.find((line) => line.startsWith('event: '))?.slice(7);
      const data = lines.find((line) => line.startsWith('data: '))?.slice(6);
      if (!event || !data) throw new Error(`Malformed SSE frame: ${frame}`);
      return { event, data: JSON.parse(data) as Record<string, unknown> };
    });
}

async function startApp(aiClientFactory: () => FakeAiClient) {
  const { app, deps } = await createTestApp(
    buildTestConfig({ ai: { fakeProvider: true } }),
    {},
    { aiClientFactory },
  );
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, deps, url };
}

async function stopApp(app: FastifyInstance): Promise<void> {
  app.server.closeAllConnections();
  await app.close();
}

const explainBody = {
  action: 'explain',
  selectedText: '程序如何运行',
  locator: { kind: 'pdf', page: 2, percent: 0.2 },
  context: { pageText: '本页正文：程序由指令组成。' },
};

async function chat(
  url: string,
  headers: { authorization: string },
  bookId: string,
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${url}/api/books/${bookId}/ai/chat`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

it('streams an explanation, persists both messages and supports a follow-up', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 4, delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id,
    format: 'pdf',
    title: '深入理解计算机系统',
    author: 'Bryant',
  });
  const headers = await authHeader(user);

  const response = await chat(url, headers, book.id, explainBody);
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events = parseFrames(await response.text());

  expect(events.map((event) => event.event)).toContain('meta');
  expect(events.at(-1)!.event).toBe('done');
  expect(
    events
      .filter((event) => event.event === 'delta')
      .map((event) => event.data.text)
      .join(''),
  ).toContain('模拟 AI 回答');

  const meta = events.find((event) => event.event === 'meta')!.data;
  const messages = await testDb.select().from(aiMessages);
  expect(messages).toHaveLength(2);
  expect(messages.find((message) => message.role === 'user')!.content).toBe('程序如何运行');
  const assistant = messages.find((message) => message.role === 'assistant')!;
  expect(assistant).toMatchObject({ status: 'complete', action: 'explain' });
  expect(assistant.content).toContain('模拟 AI 回答');
  expect(meta).toMatchObject({
    threadId: assistant.threadId,
    assistantMessageId: assistant.id,
  });

  const prompt = fake.lastRequest!.messages.map((message) => message.content).join('\n');
  expect(prompt).toContain('程序如何运行');
  expect(prompt).toContain('本页正文：程序由指令组成。');
  expect(prompt).toContain('深入理解计算机系统');

  const usage = await testDb.select().from(aiUsage);
  expect(usage).toHaveLength(2);
  expect(usage.every((row) => row.reservedTokens === 0)).toBe(true);

  // A follow-up reuses the thread and replays the earlier assistant answer.
  const followUp = await chat(url, headers, book.id, {
    action: 'ask',
    question: '再展开一点',
    threadId: String(meta.threadId),
  });
  expect(followUp.status).toBe(200);
  const followUpEvents = parseFrames(await followUp.text());
  expect(followUpEvents.at(-1)!.event).toBe('done');
  expect(await testDb.select().from(aiMessages)).toHaveLength(4);

  // Exactly-once settlement: the persisted counters equal the two reported usages.
  const doneUsages = [events, followUpEvents]
    .map((list) => list.find((event) => event.event === 'done')!.data.usage as {
      promptTokens: number;
      completionTokens: number;
    });
  const expectedPrompt = doneUsages.reduce((sum, item) => sum + item.promptTokens, 0);
  const expectedCompletion = doneUsages.reduce((sum, item) => sum + item.completionTokens, 0);
  const day = (await testDb.select().from(aiUsage)).find((row) => row.period === 'day')!;
  expect(day.promptTokens).toBe(expectedPrompt);
  expect(day.completionTokens).toBe(expectedCompletion);
  expect(day.reservedTokens).toBe(0);
  const replay = fake.lastRequest!.messages.map((message) => message.content).join('\n');
  expect(replay).toContain('再展开一点');
  expect(replay).toContain('模拟 AI 回答');

  await stopApp(app);
});

it('rejects disabled accounts, missing configuration, exhausted quotas and foreign threads before streaming', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const headers = await authHeader(user);

  await testDb.update(users).set({ aiEnabled: false }).where(eq(users.id, user.id));
  const disabled = await chat(url, headers, book.id, explainBody);
  expect(disabled.status).toBe(403);
  const disabledBody = (await disabled.json()) as { error: { code: string } };
  expect(disabledBody.error.code).toBe('AI_DISABLED');

  await testDb
    .update(users)
    .set({ aiEnabled: true, aiDailyTokenLimit: 10 })
    .where(eq(users.id, user.id));
  const quota = await chat(url, headers, book.id, explainBody);
  expect(quota.status).toBe(429);
  const quotaBody = (await quota.json()) as { error: { code: string } };
  expect(quotaBody.error.code).toBe('AI_QUOTA_EXCEEDED');
  expect(fake.lastRequest).toBeNull();
  expect(await testDb.select().from(aiMessages)).toHaveLength(0);
  await testDb.update(users).set({ aiDailyTokenLimit: 100_000 }).where(eq(users.id, user.id));

  const owner = await seedUser('member');
  const [thread] = await testDb
    .insert(aiThreads)
    .values({ userId: owner.id, bookId: book.id, title: '别人的线程' })
    .returning();
  const foreign = await chat(url, headers, book.id, {
    ...explainBody,
    threadId: thread!.id,
  });
  expect(foreign.status).toBe(404);
  await foreign.text();

  const otherBook = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  await testDb.insert(aiThreads).values({
    userId: user.id,
    bookId: otherBook.id,
    title: '另一本书的线程',
  });
  const wrongBookThread = await testDb.select().from(aiThreads).where(eq(aiThreads.bookId, otherBook.id));
  const crossBook = await chat(url, headers, book.id, {
    ...explainBody,
    threadId: wrongBookThread[0]!.id,
  });
  expect(crossBook.status).toBe(404);
  await crossBook.text();

  await testDb.update(books).set({ deletedAt: new Date() }).where(eq(books.id, book.id));
  const missingBook = await chat(url, headers, book.id, explainBody);
  expect(missingBook.status).toBe(404);
  await missingBook.text();
  expect(fake.lastRequest).toBeNull();

  await stopApp(app);
});

it('returns 503 when no provider is configured', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app } = await createTestApp(
    buildTestConfig(),
    {},
    { aiClientFactory: () => fake },
  );
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const response = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/ai/chat`,
    headers: await authHeader(user),
    payload: explainBody,
  });
  expect(response.statusCode).toBe(503);
  expect(response.json().error.code).toBe('AI_NOT_CONFIGURED');
  await app.close();
});

it('persists a partial answer when the client disconnects', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 2, delayMs: 30 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const controller = new AbortController();

  const response = await chat(
    url,
    await authHeader(user),
    book.id,
    explainBody,
    controller.signal,
  );
  const reader = response.body!.getReader();
  const decoder = new TextDecoder();
  let received = '';
  while (!received.includes('event: delta')) {
    const chunk = await reader.read();
    if (chunk.done) break;
    received += decoder.decode(chunk.value, { stream: true });
  }
  const meta = parseFrames(received).find((event) => event.event === 'meta')!.data;
  controller.abort();

  let assistant: typeof aiMessages.$inferSelect | undefined;
  for (let attempt = 0; attempt < 80 && assistant?.status !== 'interrupted'; attempt += 1) {
    await delay(20);
    [assistant] = await testDb
      .select()
      .from(aiMessages)
      .where(eq(aiMessages.id, String(meta.assistantMessageId)));
  }
  expect(assistant?.status).toBe('interrupted');
  expect((assistant?.content.length ?? 0)).toBeGreaterThan(0);

  const usage = await testDb.select().from(aiUsage);
  expect(usage.every((row) => row.reservedTokens === 0)).toBe(true);
  expect(usage.some((row) => row.promptTokens > 0)).toBe(true);

  await stopApp(app);
});

it('reports an upstream failure and keeps the partial answer', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 2, delayMs: 0, failAfter: 2 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });

  const response = await chat(url, await authHeader(user), book.id, explainBody);
  const events = parseFrames(await response.text());
  expect(events.map((event) => event.event)).toEqual(
    expect.arrayContaining(['meta', 'delta', 'error']),
  );
  expect(events.some((event) => event.event === 'done')).toBe(false);
  expect(events.at(-1)!.data).toMatchObject({
    code: 'AI_UPSTREAM_FAILED',
    retryable: true,
    message: 'AI 服务暂时不可用，请稍后重试',
  });
  expect(JSON.stringify(events)).not.toContain('Fake AI failure');

  const assistant = (await testDb.select().from(aiMessages)).find(
    (message) => message.role === 'assistant',
  )!;
  expect(assistant.status).toBe('failed');
  expect(assistant.content.length).toBeGreaterThan(0);

  await stopApp(app);
});
