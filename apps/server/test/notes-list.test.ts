import { expect, it } from 'vitest';
import {
  authHeader,
  buildTestApp,
  resetDb,
  seedAnnotation,
  seedBook,
  seedUser,
} from './helpers';

function notesUrl(params: Record<string, string | number> = {}): string {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    search.set(key, String(value));
  }
  const query = search.toString();
  return query ? `/api/notes?${query}` : '/api/notes';
}

it("lists only the caller's live notes on live books, newest first", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const live = await seedBook({ uploadedBy: alice.id, title: '活着的书', author: '作者甲' });
  const trashed = await seedBook({
    uploadedBy: alice.id,
    title: '回收站的书',
    deletedAt: new Date('2026-10-01T00:00:00Z'),
  });

  const older = await seedAnnotation({
    userId: alice.id,
    bookId: live.id,
    selectedText: '较早的划线',
    updatedAt: new Date('2026-10-01T00:00:00Z'),
  });
  const newer = await seedAnnotation({
    userId: alice.id,
    bookId: live.id,
    selectedText: '较新的划线',
    updatedAt: new Date('2026-10-02T00:00:00Z'),
  });
  await seedAnnotation({
    userId: alice.id,
    bookId: live.id,
    selectedText: '已删除的笔记',
    deletedAt: new Date('2026-10-03T00:00:00Z'),
  });
  await seedAnnotation({ userId: alice.id, bookId: trashed.id, selectedText: '回收站里的笔记' });
  await seedAnnotation({ userId: bob.id, bookId: live.id, selectedText: '别人的笔记' });

  const response = await app.inject({
    method: 'GET',
    url: notesUrl(),
    headers: await authHeader(alice),
  });

  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.total).toBe(2);
  expect(body.items.map((item: { id: string }) => item.id)).toEqual([newer.id, older.id]);
  expect(body.items[0].book).toMatchObject({
    id: live.id,
    title: '活着的书',
    author: '作者甲',
    format: 'pdf',
  });
  expect(body.items[0]).toMatchObject({
    selectedText: '较新的划线',
    type: 'note',
    color: 'yellow',
  });
  expect(body).toMatchObject({ page: 1, pageSize: 30 });
});

it('searches selected text and note text literally', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const book = await seedBook({ uploadedBy: alice.id });

  await seedAnnotation({ userId: alice.id, bookId: book.id, selectedText: '进度 100% 完成' });
  await seedAnnotation({ userId: alice.id, bookId: book.id, selectedText: '进度 1000 完成' });
  await seedAnnotation({ userId: alice.id, bookId: book.id, selectedText: 'progress report' });
  await seedAnnotation({
    userId: alice.id,
    bookId: book.id,
    selectedText: '普通引用',
    noteText: '批注里也提到 PROGRESS',
  });

  const headers = await authHeader(alice);
  const search = async (q: string) =>
    (await app.inject({ method: 'GET', url: notesUrl({ q }), headers })).json();

  const percent = await search('100%');
  expect(percent.total).toBe(1);
  expect(percent.items[0].selectedText).toBe('进度 100% 完成');

  // LIKE wildcards and regular-expression characters stay literal.
  expect((await search('_')).total).toBe(0);
  expect((await search('.')).total).toBe(0);

  // Whitespace-only input is trimmed to "no filter".
  expect((await search('  ')).total).toBe(4);

  const insensitive = await search('PROGRESS');
  expect(insensitive.total).toBe(2);
  expect(insensitive.items.map((item: { selectedText: string }) => item.selectedText).sort()).toEqual([
    'progress report',
    '普通引用',
  ]);
});

it('filters by book, tag and type', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const first = await seedBook({ uploadedBy: alice.id, title: '第一本' });
  const second = await seedBook({ uploadedBy: alice.id, title: '第二本' });

  const highlighted = await seedAnnotation({
    userId: alice.id,
    bookId: first.id,
    type: 'highlight',
    selectedText: '第一本的划线',
    tags: ['方法论'],
  });
  const commented = await seedAnnotation({
    userId: alice.id,
    bookId: first.id,
    type: 'note',
    selectedText: '第一本的批注',
    tags: ['方法论', '历史'],
  });
  const otherBook = await seedAnnotation({
    userId: alice.id,
    bookId: second.id,
    type: 'note',
    selectedText: '第二本的批注',
    tags: ['历史'],
  });

  const headers = await authHeader(alice);
  const list = async (params: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: notesUrl(params), headers })).json();

  expect((await list({ bookId: first.id })).total).toBe(2);
  expect((await list({ bookId: second.id })).items.map((item: { id: string }) => item.id)).toEqual([
    otherBook.id,
  ]);

  const tagged = await list({ tag: '方法论' });
  expect(tagged.total).toBe(2);
  expect(tagged.items.map((item: { id: string }) => item.id).sort()).toEqual(
    [highlighted.id, commented.id].sort(),
  );

  expect((await list({ type: 'highlight' })).items.map((item: { id: string }) => item.id)).toEqual([
    highlighted.id,
  ]);

  const combined = await list({ bookId: first.id, tag: '方法论', type: 'note' });
  expect(combined.total).toBe(1);
  expect(combined.items[0].id).toBe(commented.id);

  expect((await list({ tag: '不存在的标签' })).total).toBe(0);
});

it('interprets date filters in the user timezone', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const book = await seedBook({ uploadedBy: alice.id });
  // 16:30Z is already the next day in Asia/Shanghai (UTC+8).
  const note = await seedAnnotation({
    userId: alice.id,
    bookId: book.id,
    selectedText: '跨日期的笔记',
    updatedAt: new Date('2026-10-18T16:30:00Z'),
  });

  const headers = await authHeader(alice);
  const list = async (params: Record<string, string>) =>
    (await app.inject({ method: 'GET', url: notesUrl(params), headers })).json();

  const fromSameDay = await list({ from: '2026-10-19' });
  expect(fromSameDay.total).toBe(1);
  expect(fromSameDay.items[0].id).toBe(note.id);

  expect((await list({ from: '2026-10-18', to: '2026-10-18' })).total).toBe(0);
  expect((await list({ from: '2026-10-19', to: '2026-10-19' })).total).toBe(1);
  expect((await list({ to: '2026-10-17' })).total).toBe(0);
});

it('paginates without duplicates', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const book = await seedBook({ uploadedBy: alice.id });

  for (let index = 0; index < 5; index += 1) {
    await seedAnnotation({
      userId: alice.id,
      bookId: book.id,
      selectedText: `第 ${index} 条`,
      updatedAt: new Date(`2026-10-0${index + 1}T00:00:00Z`),
    });
  }

  const headers = await authHeader(alice);
  const pages = await Promise.all(
    [1, 2, 3].map(async (page) =>
      (
        await app.inject({
          method: 'GET',
          url: notesUrl({ page, pageSize: 2 }),
          headers,
        })
      ).json(),
    ),
  );

  const ids = pages.flatMap((body) => body.items.map((item: { id: string }) => item.id));
  expect(ids).toHaveLength(5);
  expect(new Set(ids).size).toBe(5);
  for (const body of pages) {
    expect(body.total).toBe(5);
    expect(body.pageSize).toBe(2);
  }
  expect(pages.map((body) => body.items.length)).toEqual([2, 2, 1]);
});

it('returns tag counts ordered by frequency', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id });
  const trashed = await seedBook({
    uploadedBy: alice.id,
    title: '回收站的书',
    deletedAt: new Date('2026-10-01T00:00:00Z'),
  });

  await seedAnnotation({ userId: alice.id, bookId: book.id, tags: ['方法论', '历史'] });
  await seedAnnotation({ userId: alice.id, bookId: book.id, tags: ['方法论'] });
  await seedAnnotation({ userId: alice.id, bookId: book.id, tags: ['方法论'] });
  await seedAnnotation({ userId: alice.id, bookId: book.id, tags: ['方法论'], deletedAt: new Date() });
  await seedAnnotation({ userId: alice.id, bookId: trashed.id, tags: ['方法论'] });
  await seedAnnotation({ userId: bob.id, bookId: book.id, tags: ['方法论', '别人'] });
  await seedAnnotation({ userId: alice.id, bookId: book.id, tags: ['历史', '读书'] });

  const response = await app.inject({
    method: 'GET',
    url: '/api/notes/tags',
    headers: await authHeader(alice),
  });

  expect(response.statusCode).toBe(200);
  expect(response.json().items).toEqual([
    { tag: '方法论', count: 3 },
    { tag: '历史', count: 2 },
    { tag: '读书', count: 1 },
  ]);
});
