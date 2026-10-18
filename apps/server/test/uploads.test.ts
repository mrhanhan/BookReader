import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { uploadSessions, books } from '../src/db/schema';
import {
  authHeader,
  buildTestApp,
  cleanupExpiredUploadsForTest,
  cleanupTrashForTest,
  enqueuedJobs,
  expireSession,
  fakeStorage,
  findSessionObjectKey,
  resetDb,
  seedBook,
  seedUser,
  testDb,
} from './helpers';

const PDF_HEAD = Buffer.from('%PDF-1.7\n');
const sha = (c: string) => c.repeat(64);

it('creates a presigned upload session for an authenticated member', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: await authHeader(user),
    payload: {
      filename: 'book.pdf',
      size: 1024,
      sha256: sha('a'),
      contentType: 'application/pdf',
    },
  });
  expect(res.statusCode).toBe(201);
  const body = res.json();
  expect(body.upload.url).toContain('original.pdf');
  expect(body.upload.fields['X-Amz-Expires']).toBe('900');
  // The POST policy pins the exact length so the client cannot overshoot.
  expect(body.upload.fields['X-Amz-Content-Length-Range']).toBe('1024-1024');
});

it('returns 409 with the existing book id for a duplicate sha256', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const existing = await seedBook({ uploadedBy: user.id, sha256: sha('b'), size: 10 });
  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: await authHeader(user),
    payload: { filename: 'copy.pdf', size: 10, sha256: sha('b'), contentType: 'application/pdf' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('DUPLICATE_BOOK');
  expect(res.json().error.details.existingBookId).toBe(existing.id);
});

it('rejects uploads that would exceed the member quota', async () => {
  await resetDb();
  const app = await buildTestApp({ memberUploadQuotaBytes: 100 });
  const user = await seedUser('member');
  await seedBook({ uploadedBy: user.id, sha256: sha('c'), size: 80 });
  const res = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: await authHeader(user),
    payload: { filename: 'big.pdf', size: 30, sha256: sha('d'), contentType: 'application/pdf' },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error.code).toBe('QUOTA_EXCEEDED');
});

it('counts trashed books against the quota until the purge frees them', async () => {
  await resetDb();
  const app = await buildTestApp({ memberUploadQuotaBytes: 100 });
  const user = await seedUser('member');
  const trashed = await seedBook({
    uploadedBy: user.id,
    sha256: sha('5'),
    size: 80,
    deletedAt: new Date(),
  });

  const payload = {
    filename: 'after-trash.pdf',
    size: 30,
    sha256: sha('4'),
    contentType: 'application/pdf',
  };
  // The row is hidden from the shelf but its object still occupies disk for
  // the 30-day retention window, so the quota must still count it.
  const blocked = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: await authHeader(user),
    payload,
  });
  expect(blocked.statusCode).toBe(409);
  expect(blocked.json().error.code).toBe('QUOTA_EXCEEDED');

  await testDb
    .update(books)
    .set({ deletedAt: new Date(Date.now() - 31 * 86_400_000) })
    .where(eq(books.id, trashed.id));
  expect(await cleanupTrashForTest()).toBe(1);

  const allowed = await app.inject({
    method: 'POST',
    url: '/api/uploads',
    headers: await authHeader(user),
    payload,
  });
  expect(allowed.statusCode).toBe(201);
});

it('does not oversell the quota under concurrent uploads', async () => {
  await resetDb();
  const app = await buildTestApp({ memberUploadQuotaBytes: 100 });
  const user = await seedUser('member');
  const payload = (c: string) => ({
    filename: 'x.pdf',
    size: 60,
    sha256: sha(c),
    contentType: 'application/pdf',
  });
  const [a, b] = await Promise.all([
    app.inject({ method: 'POST', url: '/api/uploads', headers: await authHeader(user), payload: payload('e') }),
    app.inject({ method: 'POST', url: '/api/uploads', headers: await authHeader(user), payload: payload('f') }),
  ]);
  expect([a.statusCode, b.statusCode].sort()).toEqual([201, 409]);
});

it('rejects a file whose bytes do not match its extension', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: await authHeader(user),
      payload: {
        filename: 'fake.pdf',
        size: PDF_HEAD.length,
        sha256: sha('1'),
        contentType: 'application/pdf',
      },
    })
  ).json();
  const key = await findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(key, Buffer.from('not a pdf at all'), 'application/pdf');
  const res = await app.inject({
    method: 'POST',
    url: `/api/uploads/${created.uploadId}/complete`,
    headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe('INVALID_FILE');
  expect(await fakeStorage.head(key)).toBeNull();
});

it('completes a valid upload and queues metadata extraction', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: await authHeader(user),
      payload: {
        filename: ' Sample Book.pdf',
        size: PDF_HEAD.length,
        sha256: sha('2'),
        contentType: 'application/pdf',
      },
    })
  ).json();
  const key = await findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(key, PDF_HEAD, 'application/pdf');
  const res = await app.inject({
    method: 'POST',
    url: `/api/uploads/${created.uploadId}/complete`,
    headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(200);
  expect(res.json().book).toMatchObject({ title: 'Sample Book', format: 'pdf', size: PDF_HEAD.length });
  expect(enqueuedJobs()).toContainEqual(expect.objectContaining({ type: 'metadata' }));
});

it('expires stale sessions and deletes their objects', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: await authHeader(user),
      payload: { filename: 'old.pdf', size: 10, sha256: sha('3'), contentType: 'application/pdf' },
    })
  ).json();
  await expireSession(created.uploadId, 25 * 3600 * 1000);
  const removed = await cleanupExpiredUploadsForTest();
  expect(removed).toBe(1);
  expect(await fakeStorage.head(await findSessionObjectKey(created.uploadId))).toBeNull();
});

it('rejects a completion that races with an already completed upload', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const duplicateSha = sha('9');

  const createSession = async (filename: string) =>
    (
      await app.inject({
        method: 'POST',
        url: '/api/uploads',
        headers: await authHeader(user),
        payload: { filename, size: PDF_HEAD.length, sha256: duplicateSha, contentType: 'application/pdf' },
      })
    ).json();

  // Create-time dedupe only looks at books, so two pending sessions with the
  // same content may coexist; the partial unique index decides the winner.
  const first = await createSession('first.pdf');
  const second = await createSession('second.pdf');
  const firstKey = await findSessionObjectKey(first.uploadId);
  const secondKey = await findSessionObjectKey(second.uploadId);
  await fakeStorage.putObject(firstKey, PDF_HEAD, 'application/pdf');
  await fakeStorage.putObject(secondKey, PDF_HEAD, 'application/pdf');

  const firstRes = await app.inject({
    method: 'POST',
    url: `/api/uploads/${first.uploadId}/complete`,
    headers: await authHeader(user),
  });
  expect(firstRes.statusCode).toBe(200);
  const firstBookId = firstRes.json().book.id;

  const secondRes = await app.inject({
    method: 'POST',
    url: `/api/uploads/${second.uploadId}/complete`,
    headers: await authHeader(user),
  });
  expect(secondRes.statusCode).toBe(409);
  expect(secondRes.json().error.code).toBe('DUPLICATE_BOOK');
  expect(secondRes.json().error.details.existingBookId).toBe(firstBookId);
  expect(await fakeStorage.head(secondKey)).toBeNull();

  const [secondSession] = await testDb
    .select({ status: uploadSessions.status })
    .from(uploadSessions)
    .where(eq(uploadSessions.id, second.uploadId));
  expect(secondSession?.status).toBe('failed');
});

it('hides another member\'s upload session', async () => {
  await resetDb();
  const app = await buildTestApp();
  const owner = await seedUser('member', 'upload_owner');
  const other = await seedUser('member', 'upload_other');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: await authHeader(owner),
      payload: {
        filename: 'private.pdf',
        size: PDF_HEAD.length,
        sha256: sha('7'),
        contentType: 'application/pdf',
      },
    })
  ).json();
  const key = await findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(key, PDF_HEAD, 'application/pdf');

  const res = await app.inject({
    method: 'POST',
    url: `/api/uploads/${created.uploadId}/complete`,
    headers: await authHeader(other),
  });
  expect(res.statusCode).toBe(404);
  expect(res.json().error.code).toBe('NOT_FOUND');
  expect(await fakeStorage.head(key)).not.toBeNull();
});

it('refuses to complete an expired session', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: await authHeader(user),
      payload: {
        filename: 'late.pdf',
        size: PDF_HEAD.length,
        sha256: sha('8'),
        contentType: 'application/pdf',
      },
    })
  ).json();
  const key = await findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(key, PDF_HEAD, 'application/pdf');
  await expireSession(created.uploadId, 25 * 3600 * 1000);

  const res = await app.inject({
    method: 'POST',
    url: `/api/uploads/${created.uploadId}/complete`,
    headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(409);
  expect(await testDb.select().from(books)).toHaveLength(0);
});

it('rejects a stored size that differs from the declared size', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const created = (
    await app.inject({
      method: 'POST',
      url: '/api/uploads',
      headers: await authHeader(user),
      payload: {
        filename: 'truncated.pdf',
        size: PDF_HEAD.length,
        sha256: sha('6'),
        contentType: 'application/pdf',
      },
    })
  ).json();
  const key = await findSessionObjectKey(created.uploadId);
  await fakeStorage.putObject(
    key,
    Buffer.concat([PDF_HEAD, Buffer.from('trailing bytes')]),
    'application/pdf',
  );

  const res = await app.inject({
    method: 'POST',
    url: `/api/uploads/${created.uploadId}/complete`,
    headers: await authHeader(user),
  });
  expect(res.statusCode).toBe(422);
  expect(res.json().error.code).toBe('INVALID_FILE');
  expect(await fakeStorage.head(key)).toBeNull();
  expect(await testDb.select().from(books)).toHaveLength(0);

  const [session] = await testDb
    .select({ status: uploadSessions.status })
    .from(uploadSessions)
    .where(eq(uploadSessions.id, created.uploadId));
  expect(session?.status).toBe('failed');
});

