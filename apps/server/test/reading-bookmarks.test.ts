import { expect, it } from 'vitest';
import { bookmarks } from '../src/db/schema';
import {
  authHeader, buildTestApp, resetDb, seedBook, seedBookmark, seedUser, testDb,
} from './helpers';

const locator = { kind: 'epub' as const, cfi: 'epubcfi(/6/4!/2)', percent: 0.3 };

it('creates, renames, lists and deletes own bookmarks', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const headers = await authHeader(user);

  const created = await app.inject({
    method: 'POST', url: `/api/books/${book.id}/bookmarks`, headers,
    payload: { locator, label: '  第三章  ' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().bookmark).toMatchObject({ label: '第三章', locator });
  const id = created.json().bookmark.id;

  const renamed = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/bookmarks/${id}`, headers,
    payload: { label: '重读此处' },
  });
  expect(renamed.json().bookmark.label).toBe('重读此处');

  const listed = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/bookmarks`, headers,
  });
  expect(listed.json().items).toHaveLength(1);

  expect((await app.inject({
    method: 'DELETE', url: `/api/books/${book.id}/bookmarks/${id}`, headers,
  })).statusCode).toBe(204);
  expect((await app.inject({
    method: 'GET', url: `/api/books/${book.id}/bookmarks`, headers,
  })).json().items).toEqual([]);
});

it("never exposes another member's bookmark", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'epub' });
  const row = await seedBookmark({ userId: alice.id, bookId: book.id, label: 'A 的书签' });

  expect((await app.inject({
    method: 'GET', url: `/api/books/${book.id}/bookmarks`, headers: await authHeader(bob),
  })).json().items).toEqual([]);
  expect((await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/bookmarks/${row.id}`,
    headers: await authHeader(bob), payload: { label: 'B 改名' },
  })).statusCode).toBe(404);
  expect((await app.inject({
    method: 'DELETE', url: `/api/books/${book.id}/bookmarks/${row.id}`,
    headers: await authHeader(bob),
  })).statusCode).toBe(404);
  const [stored] = await testDb.select().from(bookmarks);
  expect(stored).toMatchObject({ label: 'A 的书签', deletedAt: null });
});

it('accepts a reflow locator for a PDF book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const reflowLocator = {
    kind: 'reflow' as const, sourcePage: 120, percent: 0.4, blockId: 'p120-b0',
  };

  const created = await app.inject({
    method: 'POST', url: `/api/books/${book.id}/bookmarks`,
    headers: await authHeader(user), payload: { locator: reflowLocator, label: '重排位置' },
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().bookmark.locator).toEqual(reflowLocator);
});

it('rejects a locator from the wrong engine and a trashed book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const pdf = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const wrong = await app.inject({
    method: 'POST', url: `/api/books/${pdf.id}/bookmarks`,
    headers: await authHeader(user), payload: { locator },
  });
  expect(wrong.statusCode).toBe(400);
  const trashed = await seedBook({ uploadedBy: user.id, format: 'epub', deletedAt: new Date() });
  const refused = await app.inject({
    method: 'POST', url: `/api/books/${trashed.id}/bookmarks`,
    headers: await authHeader(user), payload: { locator },
  });
  expect(refused.statusCode).toBe(404);
});
