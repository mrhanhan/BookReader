import { expect, it } from 'vitest';
import { readingProgress } from '../src/db/schema';
import {
  authHeader, buildTestApp, resetDb, seedBook, seedProgress, seedUser, testDb,
} from './helpers';

const pdfLocator = { kind: 'pdf' as const, page: 3, percent: 0.4, charOffset: 10 };

it('saves a locator and exposes only the viewer progress in shelf DTOs', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });

  const put = await app.inject({
    method: 'PUT', url: `/api/books/${book.id}/progress`,
    headers: await authHeader(alice), payload: { locator: pdfLocator },
  });
  expect(put.statusCode).toBe(200);
  expect(put.json().progress).toMatchObject({ bookId: book.id, percent: 0.4, locator: pdfLocator });

  const own = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/progress`, headers: await authHeader(alice),
  });
  expect(own.json().progress.percent).toBe(0.4);

  const other = await app.inject({
    method: 'GET', url: `/api/books/${book.id}/progress`, headers: await authHeader(bob),
  });
  expect(other.json().progress).toBeNull();

  const aliceShelf = await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(alice) });
  const bobShelf = await app.inject({ method: 'GET', url: '/api/books', headers: await authHeader(bob) });
  expect(aliceShelf.json().items[0].progressPercent).toBe(40);
  expect(bobShelf.json().items[0].progressPercent).toBe(0);
});

it('upserts one row and records the issuing device', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const headers = await authHeader(user);
  await app.inject({ method: 'PUT', url: `/api/books/${book.id}/progress`, headers, payload: { locator: pdfLocator } });
  await app.inject({
    method: 'PUT', url: `/api/books/${book.id}/progress`, headers,
    payload: { locator: { ...pdfLocator, page: 9, percent: 0.8 } },
  });
  const rows = await testDb.select().from(readingProgress);
  expect(rows).toHaveLength(1);
  expect(rows[0]).toMatchObject({ percent: 0.8, deviceId: user.deviceId });
});

it('accepts a reflow locator for a PDF book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const reflowLocator = {
    kind: 'reflow' as const, sourcePage: 120, percent: 0.4, blockId: 'p120-b0',
  };

  const put = await app.inject({
    method: 'PUT', url: `/api/books/${book.id}/progress`,
    headers: await authHeader(user), payload: { locator: reflowLocator },
  });
  expect(put.statusCode).toBe(200);
  expect(put.json().progress.locator).toEqual(reflowLocator);
});

it('rejects a locator of the wrong engine and a trashed book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const wrong = await app.inject({
    method: 'PUT', url: `/api/books/${epub.id}/progress`,
    headers: await authHeader(user), payload: { locator: pdfLocator },
  });
  expect(wrong.statusCode).toBe(400);
  expect(wrong.json().error.details).toEqual({ expectedKind: 'epub' });

  const trashed = await seedBook({ uploadedBy: user.id, format: 'pdf', deletedAt: new Date() });
  const refused = await app.inject({
    method: 'PUT', url: `/api/books/${trashed.id}/progress`,
    headers: await authHeader(user), payload: { locator: pdfLocator },
  });
  expect(refused.statusCode).toBe(404);
});

it('rejects reflow locators for EPUB and epub locators for PDF', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const headers = await authHeader(user);
  const reflowLocator = { kind: 'reflow' as const, sourcePage: 2, percent: 0.1 };
  const epubLocator = { kind: 'epub' as const, cfi: 'epubcfi(/6/4!/2)', percent: 0.1 };

  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const epubReflow = await app.inject({
    method: 'PUT', url: `/api/books/${epub.id}/progress`,
    headers, payload: { locator: reflowLocator },
  });
  expect(epubReflow.statusCode).toBe(400);
  expect(epubReflow.json().error.details).toEqual({ expectedKind: 'epub' });

  const pdf = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const pdfEpub = await app.inject({
    method: 'PUT', url: `/api/books/${pdf.id}/progress`,
    headers, payload: { locator: epubLocator },
  });
  expect(pdfEpub.statusCode).toBe(400);
  expect(pdfEpub.json().error.details).toEqual({ expectedKind: 'pdf' });
});

it('orders recent books by the viewer last read, falling back to import time', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const old = await seedBook({
    uploadedBy: alice.id, title: '旧书', createdAt: new Date('2026-01-01T00:00:00Z'),
  });
  const fresh = await seedBook({
    uploadedBy: alice.id, title: '新书', createdAt: new Date('2026-02-01T00:00:00Z'),
  });
  await seedProgress({
    userId: alice.id, bookId: old.id, percent: 0.3,
    updatedAt: new Date('2026-03-01T00:00:00Z'),
  });

  const aliceItems = (await app.inject({
    method: 'GET', url: '/api/books?sort=recent', headers: await authHeader(alice),
  })).json().items.map((item: { id: string }) => item.id);
  const bobItems = (await app.inject({
    method: 'GET', url: '/api/books?sort=recent', headers: await authHeader(bob),
  })).json().items.map((item: { id: string }) => item.id);

  expect(aliceItems).toEqual([old.id, fresh.id]);
  expect(bobItems).toEqual([fresh.id, old.id]);
});
