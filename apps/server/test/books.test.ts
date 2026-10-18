import { eq } from 'drizzle-orm';
import FormData from 'form-data';
import { expect, it } from 'vitest';
import { auditLogs, bookCategories, books, categories } from '../src/db/schema';
import { LIBRARY_ID } from '../src/library/service';
import {
  authHeader,
  buildTestApp,
  cleanupTrashForTest,
  fakeStorage,
  getBookRow,
  resetDb,
  seedBook,
  seedUser,
  testDb,
} from './helpers';

it('lists books uploaded by other members in the shared shelf', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  await seedBook({ uploadedBy: alice.id, title: '共享的书' });
  const res = await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(bob) });
  expect(res.statusCode).toBe(200);
  expect(res.json().items.map((b: { title: string }) => b.title)).toContain('共享的书');
});

it('filters by query, format, status and category, and paginates', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  await seedBook({ uploadedBy: user.id, title: '深入理解计算机系统', author: 'Bryant', format: 'pdf' });
  await seedBook({ uploadedBy: user.id, title: '三体', author: '刘慈欣', format: 'epub', status: 'finished' });
  const byQuery = await app.inject({ method: 'GET', url: '/api/books?query=刘慈欣', headers: await authHeader(user) });
  expect(byQuery.json().items).toHaveLength(1);
  const byFormat = await app.inject({ method: 'GET', url: '/api/books?format=pdf', headers: await authHeader(user) });
  expect(byFormat.json().items).toHaveLength(1);
  const paged = await app.inject({ method: 'GET', url: '/api/books?pageSize=1&page=2&sort=title', headers: await authHeader(user) });
  expect(paged.json()).toMatchObject({ total: 2, page: 2, pageSize: 1 });
});

it("forbids a member from editing or deleting another member's book", async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const book = await seedBook({ uploadedBy: owner.id, title: '原书名' });
  const patch = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: await authHeader(other), payload: { title: '被改了' } });
  expect(patch.statusCode).toBe(403);
  const del = await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, headers: await authHeader(other) });
  expect(del.statusCode).toBe(403);
  const [row] = await testDb.select().from(books);
  expect(row!.title).toBe('原书名');
  expect(row!.deletedAt).toBeNull();
});

it('lets the uploader and an admin edit the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const admin = await seedUser('admin', 'admin');
  const book = await seedBook({ uploadedBy: owner.id, title: '原书名' });
  const byOwner = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: await authHeader(owner), payload: { title: '作者改的' } });
  expect(byOwner.statusCode).toBe(200);
  const byAdmin = await app.inject({ method: 'PATCH', url: `/api/books/${book.id}`, headers: await authHeader(admin), payload: { title: '管理员改的' } });
  expect(byAdmin.statusCode).toBe(200);
  expect(byAdmin.json().book.title).toBe('管理员改的');
});

it('soft-deletes, hides from the shelf, lists in trash and restores', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, title: '待删' });
  expect((await app.inject({ method: 'DELETE', url: `/api/books/${book.id}`, headers: await authHeader(user) })).statusCode).toBe(204);
  expect((await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(user) })).json().items).toHaveLength(0);
  expect((await app.inject({ method: 'GET', url: '/api/trash', headers: await authHeader(user) })).json().items).toHaveLength(1);
  expect((await app.inject({ method: 'POST', url: `/api/books/${book.id}/restore`, headers: await authHeader(user) })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(user) })).json().items).toHaveLength(1);
  const logs = await testDb.select({ action: auditLogs.action, target: auditLogs.target }).from(auditLogs);
  expect(logs.map((log) => log.action).sort()).toEqual(['book.delete', 'book.restore']);
  expect(logs.every((log) => log.target === book.id)).toBe(true);
});

it('refuses to restore a book whose content was re-uploaded while trashed', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const sha256 = 'd'.repeat(64);
  const trashed = await seedBook({ uploadedBy: user.id, title: '旧版本', sha256 });
  await app.inject({ method: 'DELETE', url: `/api/books/${trashed.id}`, headers: await authHeader(user) });

  // The duplicate check only looks at live books, so this upload succeeds and
  // now owns the partial unique index on (library, sha256).
  const replacement = await seedBook({ uploadedBy: user.id, title: '新版本', sha256 });

  const res = await app.inject({
    method: 'POST',
    url: `/api/books/${trashed.id}/restore`,
    headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('DUPLICATE_BOOK');
  expect(res.json().error.details.existingBookId).toBe(replacement.id);
  expect((await getBookRow(trashed.id))!.deletedAt).not.toBeNull();
});

it('lets the uploader replace the cover but forbids other members', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const book = await seedBook({ uploadedBy: owner.id });
  const png = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64');
  const makeForm = () => {
    const form = new FormData();
    form.append('file', png, { filename: 'cover.png', contentType: 'image/png' });
    return form;
  };
  const deniedForm = makeForm();
  const denied = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/cover`,
    headers: { ...(await authHeader(other)), ...deniedForm.getHeaders() },
    payload: deniedForm,
  });
  expect(denied.statusCode).toBe(403);
  const okForm = makeForm();
  const ok = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/cover`,
    headers: { ...(await authHeader(owner)), ...okForm.getHeaders() },
    payload: okForm,
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json().coverUrl).toContain('cover');
});

it('filters by category and atomically replaces the book category set', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  const [tech, fiction] = await testDb
    .insert(categories)
    .values([
      { libraryId: LIBRARY_ID, name: '技术', color: '#336699', createdBy: user.id },
      { libraryId: LIBRARY_ID, name: '小说', color: '#993366', createdBy: user.id },
    ])
    .returning();
  await testDb.insert(bookCategories).values({ bookId: book.id, categoryId: tech!.id });

  const filtered = await app.inject({
    method: 'GET',
    url: `/api/books?categoryId=${tech!.id}`,
    headers: await authHeader(user),
  });
  expect(filtered.json().items.map((b: { id: string }) => b.id)).toEqual([book.id]);

  const updated = await app.inject({
    method: 'PATCH',
    url: `/api/books/${book.id}`,
    headers: await authHeader(user),
    payload: { categoryIds: [fiction!.id] },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json().book.categories.map((c: { id: string }) => c.id)).toEqual([fiction!.id]);
  const replaced = await testDb
    .select()
    .from(bookCategories)
    .where(eq(bookCategories.bookId, book.id));
  expect(replaced.map((row) => row.categoryId)).toEqual([fiction!.id]);

  const rejected = await app.inject({
    method: 'PATCH',
    url: `/api/books/${book.id}`,
    headers: await authHeader(user),
    payload: { categoryIds: [crypto.randomUUID()] },
  });
  expect(rejected.statusCode).toBe(400);
  expect(rejected.json().error.code).toBe('VALIDATION_FAILED');
  const unchanged = await testDb
    .select()
    .from(bookCategories)
    .where(eq(bookCategories.bookId, book.id));
  expect(unchanged.map((row) => row.categoryId)).toEqual([fiction!.id]);
});

it('rejects a cover whose bytes are not an allowed image', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  const form = new FormData();
  form.append('file', Buffer.from('not an image'), {
    filename: 'cover.gif',
    contentType: 'image/gif',
  });
  const res = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/cover`,
    headers: { ...(await authHeader(user)), ...form.getHeaders() },
    payload: form,
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe('INVALID_FILE');
  expect((await getBookRow(book.id))!.coverKey).toBeNull();
});

it('checks cover permission before reading the request body', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const book = await seedBook({ uploadedBy: owner.id });
  const res = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/cover`,
    // A non-multipart body would be rejected by the parser, so a 403 here
    // proves the permission hook runs before the body is consumed.
    headers: { ...(await authHeader(other)), 'content-type': 'application/json' },
    payload: { not: 'a multipart form' },
  });
  expect(res.statusCode).toBe(403);
});

it('keeps a book and its file when it is restored before the purge runs', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('%PDF-1.7'), 'application/pdf');
  await testDb
    .update(books)
    .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
    .where(eq(books.id, book.id));

  const restored = await app.inject({
    method: 'POST',
    url: `/api/books/${book.id}/restore`,
    headers: await authHeader(user),
  });
  expect(restored.statusCode).toBe(200);

  expect(await cleanupTrashForTest()).toBe(0);
  expect(await getBookRow(book.id)).toBeDefined();
  expect(await fakeStorage.head(book.fileKey!)).not.toBeNull();
});

it('purges books deleted more than 30 days ago', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('%PDF-1.7'), 'application/pdf');
  await testDb
    .update(books)
    .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
    .where(eq(books.id, book.id));
  expect(await cleanupTrashForTest()).toBe(1);
  expect(await getBookRow(book.id)).toBeUndefined();
  expect(await fakeStorage.head(book.fileKey!)).toBeNull();
});
