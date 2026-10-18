import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { books } from '../src/db/schema';
import {
  authHeader,
  buildTestApp,
  fakeStorage,
  resetDb,
  seedBook,
  seedUser,
  testDb,
} from './helpers';

/**
 * `seedBook` does not expose the conversion column, so set `epubKey` on the row
 * it created instead of widening the shared helper for this task.
 */
async function setEpubKey(bookId: string, epubKey: string): Promise<void> {
  await testDb.update(books).set({ epubKey }).where(eq(books.id, bookId));
}

it('signs the original PDF for any member', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const reader = await seedUser('member', 'reader');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', fileKey: 'books/a.pdf' });
  fakeStorage.objects.set('books/a.pdf', Buffer.from('%PDF'));
  const res = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/file`, headers: await authHeader(reader),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    url: 'https://fake-s3.local/bookr/books/a.pdf?X-Amz-Expires=3600',
    format: 'pdf', expiresIn: 3600,
  });
});

it('reads MOBI through the converted EPUB and refuses before conversion', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const pending = await seedBook({ uploadedBy: user.id, format: 'mobi', fileKey: 'books/a.mobi' });
  const refused = await app.inject({
    method: 'GET', url: `/api/books/${pending.id}/file`, headers: await authHeader(user),
  });
  expect(refused.statusCode).toBe(409);
  expect(refused.json().error).toMatchObject({
    code: 'BOOK_NOT_READY', details: { conversionStatus: 'none' },
  });

  const converted = await seedBook({
    uploadedBy: user.id, format: 'azw3', fileKey: 'books/b.azw3',
    conversionStatus: 'done',
  });
  await setEpubKey(converted.id, 'books/b.epub');
  const ok = await app.inject({
    method: 'GET', url: `/api/books/${converted.id}/file`, headers: await authHeader(user),
  });
  expect(ok.statusCode).toBe(200);
  expect(ok.json()).toMatchObject({ format: 'epub' });
  expect(ok.json().url).toContain('books/b.epub');
});

it('404s for a missing object key and for a trashed book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const missing = await seedBook({ uploadedBy: user.id, format: 'pdf', fileKey: null });
  const missingRes = await app.inject({
    method: 'GET', url: `/api/books/${missing.id}/file`, headers: await authHeader(user),
  });
  expect(missingRes.statusCode).toBe(404);
  expect(missingRes.json().error.code).toBe('FILE_MISSING');

  const trashed = await seedBook({
    uploadedBy: user.id, format: 'pdf', fileKey: 'books/c.pdf', deletedAt: new Date(),
  });
  const trashedRes = await app.inject({
    method: 'GET', url: `/api/books/${trashed.id}/file`, headers: await authHeader(user),
  });
  expect(trashedRes.statusCode).toBe(404);
});

it('uses an existing EPUB conversion regardless of conversionStatus', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const converted = await seedBook({
    uploadedBy: user.id, format: 'mobi', fileKey: 'books/c.mobi', conversionStatus: 'failed',
  });
  await setEpubKey(converted.id, 'books/c.epub');
  const res = await app.inject({
    method: 'GET', url: `/api/books/${converted.id}/file`, headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().url).toContain('books/c.epub');
});

it('signs a native EPUB from its original file key', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'epub', fileKey: 'books/d.epub' });
  const res = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/file`, headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json()).toEqual({
    url: 'https://fake-s3.local/bookr/books/d.epub?X-Amz-Expires=3600',
    format: 'epub', expiresIn: 3600,
  });
});

it('requires authentication', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf', fileKey: 'books/e.pdf' });
  const res = await app.inject({ method: 'GET', url: `/api/books/${book.id}/file` });
  expect(res.statusCode).toBe(401);
});
