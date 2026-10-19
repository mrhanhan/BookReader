import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { FakeAiClient } from '../src/ai/fake';
import { aiUsage, noteAnalyses, users, type NoteAnalysisRow } from '../src/db/schema';
import {
  authHeader,
  buildTestConfig,
  createTestApp,
  resetDb,
  seedAnnotation,
  seedBook,
  seedNoteAnalysis,
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

const FAKE_REPLY = '【模拟 AI 回答】已收到上下文，这是本地假提供方返回的流式内容。';

async function startApp(aiClientFactory: () => FakeAiClient) {
  const { app } = await createTestApp(
    buildTestConfig({ ai: { fakeProvider: true } }),
    {},
    { aiClientFactory },
  );
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, url };
}

async function stopApp(app: FastifyInstance): Promise<void> {
  app.server.closeAllConnections();
  await app.close();
}

async function analyze(
  url: string,
  headers: { authorization: string },
  body: unknown,
  signal?: AbortSignal,
): Promise<Response> {
  return fetch(`${url}/api/notes/analyses`, {
    method: 'POST',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify(body),
    ...(signal ? { signal } : {}),
  });
}

it('streams an analysis and persists it', async () => {
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
  await seedAnnotation({
    userId: user.id,
    bookId: book.id,
    selectedText: '程序由指令组成',
    noteText: '指令是执行的基本单位',
  });
  await seedAnnotation({ userId: user.id, bookId: book.id, selectedText: '缓存提高性能' });

  const response = await analyze(url, await authHeader(user), { kind: 'themes' });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  const events = parseFrames(await response.text());

  expect(events.map((event) => event.event)).toContain('meta');
  expect(events.at(-1)!.event).toBe('done');
  const meta = events.find((event) => event.event === 'meta')!.data;
  expect(meta).toMatchObject({
    kind: 'themes',
    noteCount: 2,
    analyzedCount: 2,
    model: 'deepseek-reasoner',
    promptVersion: 'p6.1',
  });

  const streamed = events
    .filter((event) => event.event === 'delta')
    .map((event) => event.data.text)
    .join('');
  expect(streamed).toContain(FAKE_REPLY);

  const [row] = await testDb.select().from(noteAnalyses);
  expect(row).toMatchObject({
    status: 'complete',
    title: '《深入理解计算机系统》主题归纳',
    noteCount: 2,
    analyzedCount: 2,
    model: 'deepseek-reasoner',
    promptVersion: 'p6.1',
    scope: {},
  });
  expect(row!.content).toBe(FAKE_REPLY);
  expect(row!.promptTokens).toBeGreaterThan(0);
  expect(row!.completionTokens).toBeGreaterThan(0);
  expect(events.at(-1)!.data.analysisId).toBe(row!.id);

  const prompt = fake.lastRequest!.messages.map((message) => message.content).join('\n');
  expect(prompt).toContain('深入理解计算机系统');
  expect(prompt).toContain('程序由指令组成');
  expect(prompt).toContain('缓存提高性能');

  await stopApp(app);
});

it('only analyses notes inside the requested filters', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, title: '方法论手册' });
  await seedAnnotation({
    userId: user.id,
    bookId: book.id,
    selectedText: '只属于方法论的划线',
    tags: ['方法论'],
  });
  await seedAnnotation({
    userId: user.id,
    bookId: book.id,
    selectedText: '只属于历史的划线',
    tags: ['历史'],
  });

  const response = await analyze(url, await authHeader(user), {
    kind: 'themes',
    filters: { tag: '方法论' },
  });
  const events = parseFrames(await response.text());
  const meta = events.find((event) => event.event === 'meta')!.data;
  expect(meta).toMatchObject({ noteCount: 1, analyzedCount: 1 });

  const prompt = fake.lastRequest!.messages.map((message) => message.content).join('\n');
  expect(prompt).toContain('只属于方法论的划线');
  expect(prompt).not.toContain('只属于历史的划线');

  await stopApp(app);
});

it('rejects an empty scope before reserving quota', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  await seedBook({ uploadedBy: user.id });

  const response = await analyze(url, await authHeader(user), { kind: 'themes' });
  expect(response.status).toBe(400);
  const body = (await response.json()) as {
    error: { code: string; details?: { reason?: string } };
  };
  expect(body.error.code).toBe('VALIDATION_FAILED');
  expect(body.error.details?.reason).toBe('no_notes');
  expect(await testDb.select().from(aiUsage)).toHaveLength(0);
  expect(await testDb.select().from(noteAnalyses)).toHaveLength(0);
  expect(fake.lastRequest).toBeNull();

  await stopApp(app);
});

it('enforces the AI switch and configuration', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedAnnotation({ userId: user.id, bookId: book.id, selectedText: '一条划线' });
  const headers = await authHeader(user);

  await testDb.update(users).set({ aiEnabled: false }).where(eq(users.id, user.id));
  const disabled = await analyze(url, headers, { kind: 'themes' });
  expect(disabled.status).toBe(403);
  expect(((await disabled.json()) as { error: { code: string } }).error.code).toBe('AI_DISABLED');
  await testDb.update(users).set({ aiEnabled: true }).where(eq(users.id, user.id));
  await stopApp(app);

  // Without a stored provider configuration every analysis is rejected.
  const { app: bare } = await createTestApp(
    buildTestConfig(),
    {},
    { aiClientFactory: () => fake },
  );
  const bareUrl = await bare.listen({ port: 0, host: '127.0.0.1' });
  const unconfigured = await analyze(bareUrl, headers, { kind: 'themes' });
  expect(unconfigured.status).toBe(503);
  expect(
    ((await unconfigured.json()) as { error: { code: string } }).error.code,
  ).toBe('AI_NOT_CONFIGURED');
  expect(fake.lastRequest).toBeNull();
  await stopApp(bare);
});

it('refuses before calling upstream when quota is exhausted', async () => {
  await resetDb();
  const fake = new FakeAiClient({ delayMs: 0 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedAnnotation({ userId: user.id, bookId: book.id, selectedText: '一条划线' });
  await testDb.update(users).set({ aiDailyTokenLimit: 0 }).where(eq(users.id, user.id));

  const response = await analyze(url, await authHeader(user), { kind: 'themes' });
  expect(response.status).toBe(429);
  expect(
    ((await response.json()) as { error: { code: string } }).error.code,
  ).toBe('AI_QUOTA_EXCEEDED');
  expect(fake.lastRequest).toBeNull();
  expect(await testDb.select().from(noteAnalyses)).toHaveLength(0);

  await stopApp(app);
});

it('keeps partial content when the client aborts', async () => {
  await resetDb();
  const fake = new FakeAiClient({ chunkSize: 2, delayMs: 20 });
  const { app, url } = await startApp(() => fake);
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedAnnotation({ userId: user.id, bookId: book.id, selectedText: '一条划线' });
  const controller = new AbortController();

  const response = await analyze(
    url,
    await authHeader(user),
    { kind: 'themes' },
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

  let row: NoteAnalysisRow | undefined;
  for (let attempt = 0; attempt < 80 && row?.status !== 'interrupted'; attempt += 1) {
    await delay(20);
    [row] = await testDb
      .select()
      .from(noteAnalyses)
      .where(eq(noteAnalyses.id, String(meta.analysisId)));
  }
  expect(row?.status).toBe('interrupted');
  expect(row?.content.length ?? 0).toBeGreaterThan(0);

  const usage = await testDb.select().from(aiUsage);
  expect(usage.every((item) => item.reservedTokens === 0)).toBe(true);
  expect(usage.some((item) => item.promptTokens > 0)).toBe(true);

  await stopApp(app);
});

it("hides another member's analyses", async () => {
  await resetDb();
  const { app } = await createTestApp(
    buildTestConfig({ ai: { fakeProvider: true } }),
    {},
    { aiClientFactory: () => new FakeAiClient({ delayMs: 0 }) },
  );
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const aliceDone = await seedNoteAnalysis({
    userId: alice.id,
    status: 'complete',
    title: 'Alice 的分析',
    content: 'Alice 的正文',
  });
  await seedNoteAnalysis({ userId: alice.id, status: 'streaming', title: '进行中的分析' });
  const bobDone = await seedNoteAnalysis({
    userId: bob.id,
    status: 'complete',
    title: 'Bob 的分析',
  });
  const aliceHeaders = await authHeader(alice);
  const bobHeaders = await authHeader(bob);

  const foreignGet = await app.inject({
    method: 'GET',
    url: `/api/notes/analyses/${aliceDone.id}`,
    headers: bobHeaders,
  });
  expect(foreignGet.statusCode).toBe(404);
  const foreignDelete = await app.inject({
    method: 'DELETE',
    url: `/api/notes/analyses/${aliceDone.id}`,
    headers: bobHeaders,
  });
  expect(foreignDelete.statusCode).toBe(404);
  expect(await testDb.select().from(noteAnalyses)).toHaveLength(3);

  const bobList = await app.inject({
    method: 'GET',
    url: '/api/notes/analyses',
    headers: bobHeaders,
  });
  expect(bobList.statusCode).toBe(200);
  expect(
    (bobList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id),
  ).toEqual([bobDone.id]);

  // Streaming rows stay hidden from the caller's own list.
  const aliceList = await app.inject({
    method: 'GET',
    url: '/api/notes/analyses',
    headers: aliceHeaders,
  });
  expect(
    (aliceList.json() as { items: Array<{ id: string }> }).items.map((item) => item.id),
  ).toEqual([aliceDone.id]);

  const ownGet = await app.inject({
    method: 'GET',
    url: `/api/notes/analyses/${aliceDone.id}`,
    headers: aliceHeaders,
  });
  expect(ownGet.statusCode).toBe(200);
  expect(
    (ownGet.json() as { analysis: Record<string, unknown> }).analysis,
  ).toMatchObject({ id: aliceDone.id, content: 'Alice 的正文', scope: {} });

  const ownDelete = await app.inject({
    method: 'DELETE',
    url: `/api/notes/analyses/${aliceDone.id}`,
    headers: aliceHeaders,
  });
  expect(ownDelete.statusCode).toBe(204);
  expect(await testDb.select().from(noteAnalyses)).toHaveLength(2);

  await app.close();
});
