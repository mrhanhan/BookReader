import { expect, it } from 'vitest';
import { annotationHistory, annotations } from '../src/db/schema';
import {
  authHeader, buildTestApp, resetDb, seedAnnotation, seedBook, seedUser, testDb,
} from './helpers';

const locator = { kind: 'pdf' as const, page: 2, percent: 0.2, charOffset: 5 };
const highlight = {
  type: 'highlight', color: 'yellow', locator, selectedText: '原文', tags: [' 历史 ', '历史'],
};

it('creates and lists only the caller annotations', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });

  const created = await app.inject({
    method: 'POST', url: `/api/books/${book.id}/annotations`,
    headers: await authHeader(alice), payload: highlight,
  });
  expect(created.statusCode).toBe(201);
  expect(created.json().annotation).toMatchObject({ tags: ['历史'], revision: 1, type: 'highlight' });

  const aliceList = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/annotations`, headers: await authHeader(alice),
  });
  expect(aliceList.json().items).toHaveLength(1);
  const bobList = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/annotations`, headers: await authHeader(bob),
  });
  expect(bobList.json().items).toEqual([]);
});

it("never exposes or mutates another member's annotation", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });
  const row = await seedAnnotation({ userId: alice.id, bookId: book.id, noteText: 'A 的想法' });

  const patch = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers: await authHeader(bob), payload: { noteText: 'B 覆盖', revision: 1 },
  });
  const del = await app.inject({
    method: 'DELETE', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers: await authHeader(bob),
  });
  expect(patch.statusCode).toBe(404);
  expect(del.statusCode).toBe(404);
  const [stored] = await testDb.select().from(annotations);
  expect(stored).toMatchObject({ noteText: 'A 的想法', deletedAt: null, revision: 1 });
});

it('keeps the previous note text when an edit conflicts', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const row = await seedAnnotation({ userId: user.id, bookId: book.id, noteText: '第一版' });
  const headers = await authHeader(user);
  const first = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers, payload: { noteText: '第二版', revision: 1 },
  });
  expect(first.json()).toMatchObject({ conflict: false, annotation: { revision: 2, noteText: '第二版' } });

  const stale = await app.inject({
    method: 'PATCH', url: `/api/books/${book.id}/annotations/${row.id}`,
    headers, payload: { noteText: '第三版', revision: 1 },
  });
  expect(stale.json()).toMatchObject({ conflict: true, annotation: { revision: 3, noteText: '第三版' } });
  const history = await testDb.select().from(annotationHistory);
  expect(history.map((entry) => entry.noteText)).toEqual(['第一版', '第二版']);
});

it('rejects a locator from the wrong engine and hides deleted annotations', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const headers = await authHeader(user);
  const wrong = await app.inject({
    method: 'POST', url: `/api/books/${epub.id}/annotations`, headers, payload: highlight,
  });
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json().error.details).toEqual({ expectedKind: 'epub' });

  const created = await app.inject({
    method: 'POST', url: `/api/books/${epub.id}/annotations`, headers,
    payload: { ...highlight, locator: { kind: 'epub', cfi: 'epubcfi(/6/4!/2)', percent: 0.1 } },
  });
  const id = created.json().annotation.id;
  expect((await app.inject({
    method: 'DELETE', url: `/api/books/${epub.id}/annotations/${id}`, headers,
  })).statusCode).toBe(204);
  expect((await app.inject({
    method: 'GET', url: `/api/books/${epub.id}/annotations`, headers,
  })).json().items).toEqual([]);
});
