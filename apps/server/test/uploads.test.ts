import { expect, it } from 'vitest';
import {
  authHeader,
  buildTestApp,
  cleanupExpiredUploadsForTest,
  enqueuedJobs,
  expireSession,
  fakeStorage,
  findSessionObjectKey,
  resetDb,
  seedBook,
  seedUser,
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
  expect(res.json().putUrl).toContain('original.pdf');
  expect(res.json().putUrl).toContain('X-Amz-Expires=900');
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
