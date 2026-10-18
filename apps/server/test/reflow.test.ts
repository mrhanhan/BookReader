import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { books, reflowUploads } from '../src/db/schema';
import {
  authHeader,
  buildTestApp,
  cleanupExpiredReflowUploadsForTest,
  expireReflowSession,
  fakeStorage,
  getBookRow,
  resetDb,
  seedBook,
  seedUser,
  testDb,
  type SeededUser,
} from './helpers';

const sha = (c: string) => c.repeat(64);

/** A minimal two-page pack accepted by `reflowPackSchema`. */
function validPack(sourceSha: string, overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 1,
    source: { sha256: sourceSha, pageCount: 2 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '0.1.0' },
    quality: {
      pages: 2,
      textBlocks: 2,
      fallbackPages: [2],
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [{ label: '第一章', page: 1, level: 1 }],
    pages: [
      {
        page: 1,
        width: 612,
        height: 792,
        blocks: [
          {
            id: 'p1-b0',
            type: 'heading',
            text: '第一章',
            level: 1,
            rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 },
            sourceCharStart: 0,
            sourceCharEnd: 3,
          },
          {
            id: 'p1-b1',
            type: 'paragraph',
            text: '正文。',
            rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.05 },
            sourceCharStart: 4,
            sourceCharEnd: 7,
          },
        ],
      },
      {
        page: 2,
        width: 612,
        height: 792,
        blocks: [{ id: 'p2-b0', type: 'fallback', rect: { x: 0, y: 0, w: 1, h: 1 } }],
      },
    ],
    ...overrides,
  };
}

function packBytes(pack: unknown): Buffer {
  return Buffer.from(JSON.stringify(pack));
}

async function createUpload(
  app: FastifyInstance,
  user: SeededUser,
  bookId: string,
  size: number,
  sha256: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/books/${bookId}/reflow/uploads`,
    headers: await authHeader(user),
    payload: { size, sha256 },
  });
}

async function completeUpload(
  app: FastifyInstance,
  user: SeededUser,
  bookId: string,
  uploadId: string,
) {
  return app.inject({
    method: 'POST',
    url: `/api/books/${bookId}/reflow/uploads/${uploadId}/complete`,
    headers: await authHeader(user),
  });
}

/** Creates a session, writes the pack to the fake bucket and completes it. */
async function uploadPack(
  app: FastifyInstance,
  user: SeededUser,
  bookId: string,
  pack: unknown,
  sessionSha256: string = (pack as { source: { sha256: string } }).source.sha256,
) {
  const bytes = packBytes(pack);
  const created = await createUpload(app, user, bookId, bytes.length, sessionSha256);
  expect(created.statusCode).toBe(201);
  const body = created.json<{ uploadId: string; upload: { fields: Record<string, string> } }>();
  const key = body.upload.fields.key!;
  await fakeStorage.putObject(key, bytes, 'application/json');
  const completed = await completeUpload(app, user, bookId, body.uploadId);
  return { created, completed, key, bytes, uploadId: body.uploadId };
}

it('creates a presigned session and completes a valid pack', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const bytes = packBytes(validPack(sha('c')));
  const created = await createUpload(app, owner, book.id, bytes.length, sha('c'));
  expect(created.statusCode).toBe(201);
  const session = created.json<{
    uploadId: string;
    upload: { url: string; fields: Record<string, string> };
    expiresAt: string;
  }>();
  expect(session.upload.url).toMatch(/^https:\/\/fake-s3\.local\//);
  expect(session.upload.fields.key).toContain(`/books/${book.id}/reflow/`);
  expect(session.upload.fields.key).toMatch(/\.json$/);
  expect(session.upload.fields['Content-Type']).toBe('application/json');
  expect(session.upload.fields['X-Amz-Expires']).toBe('900');
  expect(new Date(session.expiresAt).getTime()).toBeGreaterThan(Date.now());

  const [row] = await testDb
    .select()
    .from(reflowUploads)
    .where(eq(reflowUploads.id, session.uploadId));
  expect(row).toMatchObject({
    bookId: book.id,
    userId: owner.id,
    status: 'created',
    size: bytes.length,
    sha256: sha('c'),
  });

  await fakeStorage.putObject(session.upload.fields.key!, bytes, 'application/json');
  const completed = await completeUpload(app, owner, book.id, session.uploadId);
  expect(completed.statusCode).toBe(200);
  const body = completed.json();
  expect(body.book.reflowAvailable).toBe(true);
  expect(body.pack).toEqual({
    schemaVersion: 1,
    pageCount: 2,
    blockCount: 3,
    fallbackPages: [2],
  });

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBe(session.upload.fields.key);
  expect(stored!.reflowSchemaVersion).toBe(1);
  expect(stored!.reflowPageCount).toBe(2);
  expect(stored!.reflowUpdatedAt).toBeInstanceOf(Date);

  const file = await app.inject({
    method: 'GET',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(owner),
  });
  expect(file.statusCode).toBe(200);
  expect(file.json()).toMatchObject({ schemaVersion: 1, pageCount: 2, expiresIn: 3600 });
  expect(file.json().url).toMatch(/^https:\/\/fake-s3\.local\//);
  expect(file.json().url).toContain('X-Amz-Expires=3600');
});

it('lets another active member read the pack but not manage it', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const reader = await seedUser('member', 'reader');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });
  const { key } = await uploadPack(app, owner, book.id, validPack(sha('c')));

  const read = await app.inject({
    method: 'GET',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(reader),
  });
  expect(read.statusCode).toBe(200);
  expect(read.json()).toMatchObject({ schemaVersion: 1, pageCount: 2, expiresIn: 3600 });

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(reader),
  });
  expect(removed.statusCode).toBe(403);
  expect(removed.json().error.code).toBe('FORBIDDEN');

  const created = await createUpload(app, reader, book.id, 10, sha('c'));
  expect(created.statusCode).toBe(403);
  expect(created.json().error.code).toBe('FORBIDDEN');

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBe(key);
  expect(fakeStorage.objects.has(key)).toBe(true);
});

it('rejects a pack whose source sha256 differs from the book and keeps the old pack', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const existingKey = `library/00000000-0000-7000-8000-000000000001/books/existing/reflow/old.json`;
  await fakeStorage.putObject(existingKey, Buffer.from('{}'), 'application/json');
  const book = await seedBook({
    uploadedBy: owner.id,
    format: 'pdf',
    sha256: sha('c'),
    reflowKey: existingKey,
    reflowSchemaVersion: 1,
    reflowPageCount: 2,
    reflowUpdatedAt: new Date(),
  });

  const { completed, key, uploadId } = await uploadPack(
    app,
    owner,
    book.id,
    validPack(sha('d')),
    sha('c'),
  );
  expect(completed.statusCode).toBe(422);
  expect(completed.json().error.code).toBe('REFLOW_INVALID');

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBe(existingKey);
  expect(fakeStorage.objects.has(existingKey)).toBe(true);
  // The rejected upload is cleaned up so it cannot linger as an orphan.
  expect(fakeStorage.objects.has(key)).toBe(false);

  const [session] = await testDb
    .select({ status: reflowUploads.status })
    .from(reflowUploads)
    .where(eq(reflowUploads.id, uploadId));
  expect(session!.status).toBe('failed');
});

it('rejects a pack with an unsupported schemaVersion', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const { completed, uploadId } = await uploadPack(
    app,
    owner,
    book.id,
    validPack(sha('c'), { schemaVersion: 2 }),
  );
  expect(completed.statusCode).toBe(422);
  expect(completed.json().error.code).toBe('REFLOW_INVALID');
  expect((await getBookRow(book.id))!.reflowKey).toBeNull();

  const [session] = await testDb
    .select({ status: reflowUploads.status })
    .from(reflowUploads)
    .where(eq(reflowUploads.id, uploadId));
  expect(session!.status).toBe('failed');
});

it('rejects an object that is not valid JSON', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const bytes = Buffer.from('this is not a pack');
  const created = await createUpload(app, owner, book.id, bytes.length, sha('c'));
  const { uploadId, upload } = created.json<{
    uploadId: string;
    upload: { fields: Record<string, string> };
  }>();
  await fakeStorage.putObject(upload.fields.key!, bytes, 'application/json');

  const completed = await completeUpload(app, owner, book.id, uploadId);
  expect(completed.statusCode).toBe(422);
  expect(completed.json().error.code).toBe('REFLOW_INVALID');
  expect((await getBookRow(book.id))!.reflowKey).toBeNull();
});

it('rejects a completion when no object was uploaded', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const created = await createUpload(app, owner, book.id, 128, sha('c'));
  const { uploadId } = created.json<{ uploadId: string }>();
  const completed = await completeUpload(app, owner, book.id, uploadId);
  expect(completed.statusCode).toBe(422);
  expect(completed.json().error.code).toBe('REFLOW_INVALID');
});

it('rejects an expired session with 409 and the cleanup sweep removes it', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const bytes = packBytes(validPack(sha('c')));
  const created = await createUpload(app, owner, book.id, bytes.length, sha('c'));
  const { uploadId, upload } = created.json<{
    uploadId: string;
    upload: { fields: Record<string, string> };
  }>();
  const key = upload.fields.key!;
  await fakeStorage.putObject(key, bytes, 'application/json');
  await expireReflowSession(uploadId, 60_000);

  const completed = await completeUpload(app, owner, book.id, uploadId);
  expect(completed.statusCode).toBe(409);
  expect(completed.json().error.code).toBe('CONFLICT');

  expect(await cleanupExpiredReflowUploadsForTest()).toBe(1);
  const [session] = await testDb
    .select({ status: reflowUploads.status })
    .from(reflowUploads)
    .where(eq(reflowUploads.id, uploadId));
  expect(session!.status).toBe('expired');
  expect(fakeStorage.objects.has(key)).toBe(false);
});

it('refuses to create a session for a non-PDF book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'epub', sha256: sha('c') });

  const res = await createUpload(app, owner, book.id, 128, sha('c'));
  expect(res.statusCode).toBe(400);
  expect(res.json().error.code).toBe('VALIDATION_FAILED');
});

it('rejects a create request whose sha256 does not belong to the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const res = await createUpload(app, owner, book.id, 128, sha('d'));
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe('REFLOW_INVALID');
});

it('returns 404 when the book does not exist', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');

  const res = await createUpload(app, owner, '11111111-1111-7111-8111-111111111111', 128, sha('c'));
  expect(res.statusCode).toBe(404);
  expect(res.json().error.code).toBe('NOT_FOUND');
});

it('refuses a second completion of the same session without mutating the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });
  const { key, uploadId, completed } = await uploadPack(app, owner, book.id, validPack(sha('c')));
  expect(completed.statusCode).toBe(200);

  const again = await completeUpload(app, owner, book.id, uploadId);
  expect(again.statusCode).toBe(409);
  expect(again.json().error.code).toBe('CONFLICT');

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBe(key);
  expect(fakeStorage.objects.has(key)).toBe(true);

  const [session] = await testDb
    .select({ status: reflowUploads.status })
    .from(reflowUploads)
    .where(eq(reflowUploads.id, uploadId));
  expect(session!.status).toBe('completed');
});

it('replacing a pack deletes the old object and points the book at the new key', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });

  const first = await uploadPack(app, owner, book.id, validPack(sha('c')));
  expect(first.completed.statusCode).toBe(200);
  expect(fakeStorage.objects.has(first.key)).toBe(true);

  const second = await uploadPack(
    app,
    owner,
    book.id,
    validPack(sha('c'), { generatedAt: '2026-10-18T09:00:00.000Z' }),
  );
  expect(second.completed.statusCode).toBe(200);
  expect(second.key).not.toBe(first.key);

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBe(second.key);
  expect(fakeStorage.objects.has(first.key)).toBe(false);
  expect(fakeStorage.objects.has(second.key)).toBe(true);
});

it('deletes the pack, clears the columns and removes the object', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf', sha256: sha('c') });
  const { key } = await uploadPack(app, owner, book.id, validPack(sha('c')));

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(owner),
  });
  expect(removed.statusCode).toBe(204);

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBeNull();
  expect(stored!.reflowSchemaVersion).toBeNull();
  expect(stored!.reflowPageCount).toBeNull();
  expect(stored!.reflowUpdatedAt).toBeNull();
  expect(fakeStorage.objects.has(key)).toBe(false);

  const file = await app.inject({
    method: 'GET',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(owner),
  });
  expect(file.statusCode).toBe(409);
  expect(file.json().error.code).toBe('REFLOW_NOT_READY');
});

it('reports REFLOW_NOT_READY for a book that has no pack', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const book = await seedBook({ uploadedBy: owner.id, format: 'pdf' });

  const file = await app.inject({
    method: 'GET',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(owner),
  });
  expect(file.statusCode).toBe(409);
  expect(file.json().error.code).toBe('REFLOW_NOT_READY');

  const missing = await app.inject({
    method: 'GET',
    url: '/api/books/11111111-1111-7111-8111-111111111111/reflow',
    headers: await authHeader(owner),
  });
  expect(missing.statusCode).toBe(404);
});

it('keeps the old reflowKey when the uploaded pack fails validation', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member');
  const existingKey = 'library/existing-pack.json';
  await fakeStorage.putObject(existingKey, Buffer.from('{}'), 'application/json');
  const book = await seedBook({
    uploadedBy: owner.id,
    format: 'pdf',
    sha256: sha('c'),
    reflowKey: existingKey,
    reflowSchemaVersion: 1,
    reflowPageCount: 2,
  });

  const broken = validPack(sha('c'));
  // pages.length must equal source.pageCount.
  broken.source.pageCount = 3;
  const { completed } = await uploadPack(app, owner, book.id, broken);
  expect(completed.statusCode).toBe(422);
  expect(completed.json().error.code).toBe('REFLOW_INVALID');

  const stored = await getBookRow(book.id);
  expect(stored!.reflowKey).toBe(existingKey);
  expect(stored!.reflowPageCount).toBe(2);
  expect(fakeStorage.objects.has(existingKey)).toBe(true);
});

it('signed-out callers cannot reach the reflow endpoints', async () => {
  await resetDb();
  const app = await buildTestApp();
  const book = await seedBook({ uploadedBy: (await seedUser('member')).id });

  const res = await app.inject({ method: 'GET', url: `/api/books/${book.id}/reflow` });
  expect(res.statusCode).toBe(401);
  expect(res.json().error.code).toBe('UNAUTHORIZED');
});

it('does not mutate books row on delete when the caller lacks permission', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'owner');
  const other = await seedUser('member', 'other');
  const book = await seedBook({ uploadedBy: owner.id, reflowKey: 'library/keep.json' });

  const removed = await app.inject({
    method: 'DELETE',
    url: `/api/books/${book.id}/reflow`,
    headers: await authHeader(other),
  });
  expect(removed.statusCode).toBe(403);
  const [row] = await testDb.select().from(books).where(eq(books.id, book.id));
  expect(row!.reflowKey).toBe('library/keep.json');
});
