import { newId, syncKey, type SyncPushChange } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { annotationHistory, annotations, bookmarks, readingProgress, userSettings } from '../src/db/schema';
import { maxRevision } from '../src/sync/repo';
import {
  authHeader,
  buildTestApp,
  resetDb,
  seedAnnotation,
  seedBook,
  seedUser,
  testDb,
  type SeededUser,
} from './helpers';

const T1 = '2026-10-01T00:00:00.000Z';
const T2 = '2026-10-02T00:00:00.000Z';
const T3 = '2026-10-03T00:00:00.000Z';
const locator = { kind: 'pdf' as const, page: 3, percent: 0.4 };

async function setup(): Promise<{
  app: FastifyInstance;
  user: SeededUser;
  bookId: string;
}> {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  return { app, user, bookId: book.id };
}

async function push(
  app: FastifyInstance,
  user: Pick<SeededUser, 'id' | 'role' | 'deviceId'>,
  changes: SyncPushChange[],
) {
  return app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: await authHeader(user),
    payload: { changes },
  });
}

function progressChange(bookId: string, at: string): SyncPushChange {
  return {
    entityType: 'reading_progress',
    entityId: bookId,
    op: 'upsert',
    clientUpdatedAt: at,
    payload: { bookId, locator },
  };
}

function annotationChange(
  id: string,
  bookId: string,
  at: string,
  noteText: string,
  tags: string[] = [],
): SyncPushChange {
  return {
    entityType: 'annotation',
    entityId: id,
    op: 'upsert',
    clientUpdatedAt: at,
    payload: {
      bookId,
      type: 'note',
      color: 'yellow',
      locator,
      selectedText: '原文',
      noteText,
      tags,
    },
  };
}

function bookmarkChange(id: string, bookId: string, at: string, label: string): SyncPushChange {
  return {
    entityType: 'bookmark',
    entityId: id,
    op: 'upsert',
    clientUpdatedAt: at,
    payload: { bookId, locator, label },
  };
}

it('applies a progress upsert and returns the canonical envelope', async () => {
  const { app, user, bookId } = await setup();

  const response = await push(app, user, [progressChange(bookId, T1)]);
  expect(response.statusCode).toBe(200);
  const body = response.json();
  expect(body.applied).toHaveLength(1);
  expect(body.skipped).toEqual([]);
  expect(body.rejected).toEqual([]);
  expect(body.applied[0]).toMatchObject({
    entityType: 'reading_progress',
    entityId: bookId,
    op: 'upsert',
    payload: { bookId, locator, percent: locator.percent },
  });
  expect(body.cursor).toBe(body.applied[0].revision);

  const [row] = await testDb.select().from(readingProgress);
  expect(row?.clientUpdatedAt?.toISOString()).toBe(T1);
});

it('is idempotent for a replayed batch', async () => {
  const { app, user, bookId } = await setup();
  const annotationId = newId();
  const bookmarkId = newId();
  const batch: SyncPushChange[] = [
    progressChange(bookId, T1),
    annotationChange(annotationId, bookId, T1, '想法'),
    bookmarkChange(bookmarkId, bookId, T1, '起点'),
  ];

  const first = await push(app, user, batch);
  expect(first.json().applied).toHaveLength(3);

  const again = await push(app, user, batch);
  const body = again.json();
  expect(body.applied).toEqual([]);
  expect(body.rejected).toEqual([]);
  expect(body.skipped).toEqual([
    syncKey('reading_progress', bookId),
    syncKey('annotation', annotationId),
    syncKey('bookmark', bookmarkId),
  ]);
  expect(await maxRevision(testDb, user.id)).toBe(first.json().applied[2].revision);

  const { rows } = await testDb.$client.query<{ count: string }>(
    'select count(*) from sync_changes where user_id = $1',
    [user.id],
  );
  expect(Number(rows[0]?.count)).toBe(3);
});

it('skips an older client timestamp', async () => {
  const { app, user, bookId } = await setup();
  const annotationId = newId();

  await push(app, user, [annotationChange(annotationId, bookId, T2, 'new')]);
  const stale = await push(app, user, [annotationChange(annotationId, bookId, T1, 'old')]);

  expect(stale.json().skipped).toEqual([syncKey('annotation', annotationId)]);
  const [row] = await testDb.select().from(annotations);
  expect(row).toMatchObject({ noteText: 'new', revision: 1 });
});

it('archives the replaced note text when a newer edit wins', async () => {
  const { app, user, bookId } = await setup();
  const annotationId = newId();

  await push(app, user, [annotationChange(annotationId, bookId, T1, '第一版')]);
  const second = await push(app, user, [annotationChange(annotationId, bookId, T2, '第二版')]);
  expect(second.json().applied).toHaveLength(1);

  const history = await testDb.select().from(annotationHistory);
  expect(history.map((entry) => entry.noteText)).toEqual(['第一版']);
  const [row] = await testDb.select().from(annotations);
  expect(row).toMatchObject({ noteText: '第二版', revision: 2 });
});

it('falls back to the receive time for a clock far in the future', async () => {
  const { app, user, bookId } = await setup();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();

  const response = await push(app, user, [progressChange(bookId, future)]);
  const envelope = response.json().applied[0];

  expect(envelope.clientUpdatedAt).toBe(envelope.serverUpdatedAt);
  expect(new Date(envelope.clientUpdatedAt).getTime()).toBeLessThanOrEqual(Date.now());
  const [row] = await testDb.select().from(readingProgress);
  expect(row?.clientUpdatedAt?.getTime()).toBeLessThanOrEqual(Date.now());
});

it("rejects writing another user's annotation id", async () => {
  const { app, user, bookId } = await setup();
  const other = await seedUser('member', 'other');
  const owned = await seedAnnotation({ userId: other.id, bookId, noteText: '他人' });

  const response = await push(app, user, [annotationChange(owned.id, bookId, T2, '覆盖')]);
  expect(response.json().rejected).toEqual([
    { key: syncKey('annotation', owned.id), reason: 'not_allowed' },
  ]);
  expect(response.json().applied).toEqual([]);

  const [row] = await testDb.select().from(annotations);
  expect(row).toMatchObject({ userId: other.id, noteText: '他人', revision: 1 });
  expect((await testDb.select().from(annotations)).length).toBe(1);
});

it('propagates a delete as a tombstone that a newer upsert resurrects', async () => {
  const { app, user, bookId } = await setup();
  const annotationId = newId();

  const created = await push(app, user, [annotationChange(annotationId, bookId, T1, '删除我')]);
  const createdRevision = created.json().applied[0].revision;

  const deleted = await push(app, user, [
    { entityType: 'annotation', entityId: annotationId, op: 'delete', clientUpdatedAt: T2 },
  ]);
  expect(deleted.json().applied[0]).toMatchObject({
    entityType: 'annotation',
    entityId: annotationId,
    op: 'delete',
    payload: { noteText: '删除我' },
  });

  const list = await app.inject({
    method: 'GET',
    url: `/api/books/${bookId}/annotations`,
    headers: await authHeader(user),
  });
  expect(list.json().items).toEqual([]);

  const pulled = await app.inject({
    method: 'GET',
    url: `/api/sync/pull?since=${createdRevision}`,
    headers: await authHeader(user),
  });
  expect(pulled.json().changes.map((change: { op: string }) => change.op)).toEqual(['delete']);

  const resurrect = await push(app, user, [annotationChange(annotationId, bookId, T3, '复活')]);
  expect(resurrect.json().applied).toHaveLength(1);

  const [row] = await testDb.select().from(annotations);
  expect(row).toMatchObject({ noteText: '复活', revision: 2, deletedAt: null });
  const relisted = await app.inject({
    method: 'GET',
    url: `/api/books/${bookId}/annotations`,
    headers: await authHeader(user),
  });
  expect(relisted.json().items).toHaveLength(1);
});

it('rejects a locator of the wrong kind and an unknown book', async () => {
  const { app, user } = await setup();
  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });

  const wrongKind = await push(app, user, [
    {
      entityType: 'reading_progress',
      entityId: epub.id,
      op: 'upsert',
      clientUpdatedAt: T1,
      payload: { bookId: epub.id, locator },
    },
  ]);
  expect(wrongKind.json().rejected).toEqual([
    { key: syncKey('reading_progress', epub.id), reason: 'invalid_payload' },
  ]);

  const missingBookId = newId();
  const missing = await push(app, user, [
    {
      entityType: 'reading_progress',
      entityId: missingBookId,
      op: 'upsert',
      clientUpdatedAt: T1,
      payload: { bookId: missingBookId, locator },
    },
  ]);
  expect(missing.json().rejected).toEqual([
    { key: syncKey('reading_progress', missingBookId), reason: 'unknown_entity' },
  ]);
});

it('rejects more than 100 changes', async () => {
  const { app, user, bookId } = await setup();
  const changes = Array.from({ length: 101 }, () => progressChange(bookId, T1));

  const response = await push(app, user, changes);
  expect(response.statusCode).toBe(400);
});

it('keeps each user on their own pull cursor', async () => {
  const { app, user, bookId } = await setup();
  const other = await seedUser('member', 'other');
  const otherBook = await seedBook({ uploadedBy: other.id, format: 'pdf' });

  const own = await push(app, user, [progressChange(bookId, T1)]);
  const ownRevision = own.json().applied[0].revision as number;

  await push(app, other, [progressChange(otherBook.id, T1)]);

  // The push acknowledgement reports this caller's change, not the global tip.
  expect(own.json().cursor).toBe(ownRevision);

  const pulled = await app.inject({
    method: 'GET',
    url: '/api/sync/pull?since=0',
    headers: await authHeader(user),
  });
  expect(pulled.json().cursor).toBe(ownRevision);
  expect(
    pulled.json().changes.map((change: { entityId: string }) => change.entityId),
  ).toEqual([bookId]);

  // A newer revision from another user never advances this caller's cursor.
  const again = await app.inject({
    method: 'GET',
    url: `/api/sync/pull?since=${ownRevision}`,
    headers: await authHeader(user),
  });
  expect(again.json()).toEqual({
    changes: [],
    cursor: ownRevision,
    hasMore: false,
    reset: false,
  });
});

it('stores reader settings under the user id as entity id', async () => {
  const { app, user } = await setup();

  const first = await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: user.id,
      op: 'upsert',
      clientUpdatedAt: T1,
      payload: { settings: { theme: 'dark' } },
    },
  ]);
  expect(first.json().applied).toHaveLength(1);
  expect(first.json().applied[0]).toMatchObject({
    entityType: 'reader_settings',
    entityId: user.id,
    payload: { settings: { theme: 'dark' }, clientUpdatedAt: T1 },
  });
  const [stored] = await testDb.select().from(userSettings);
  expect(stored).toMatchObject({ userId: user.id, payload: { theme: 'dark' } });

  const replay = await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: user.id,
      op: 'upsert',
      clientUpdatedAt: T1,
      payload: { settings: { theme: 'dark' } },
    },
  ]);
  expect(replay.json().skipped).toEqual([syncKey('reader_settings', user.id)]);

  const newer = await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: user.id,
      op: 'upsert',
      clientUpdatedAt: T2,
      payload: { settings: { theme: 'light' } },
    },
  ]);
  expect(newer.json().applied).toHaveLength(1);
  const [updated] = await testDb.select().from(userSettings);
  expect(updated).toMatchObject({ payload: { theme: 'light' } });
  expect((await testDb.select().from(userSettings)).length).toBe(1);

  const wrongEntity = await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: newId(),
      op: 'upsert',
      clientUpdatedAt: T3,
      payload: { settings: { theme: 'dark' } },
    },
  ]);
  expect(wrongEntity.json().rejected[0]?.reason).toBe('invalid_payload');

  const deleted = await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: user.id,
      op: 'delete',
      clientUpdatedAt: T3,
    },
  ]);
  expect(deleted.json().rejected[0]?.reason).toBe('unsupported_op');
});

it('normalizes pushed tags and blank bookmark labels', async () => {
  const { app, user, bookId } = await setup();
  const annotationId = newId();
  const bookmarkId = newId();

  await push(app, user, [
    annotationChange(annotationId, bookId, T1, '标签', [' 重复 ', '重复', ' 有效 ']),
    bookmarkChange(bookmarkId, bookId, T1, '   '),
  ]);

  const [annotation] = await testDb.select().from(annotations);
  expect(annotation?.tags).toEqual(['重复', '有效']);
  const [bookmark] = await testDb.select().from(bookmarks);
  expect(bookmark?.label).toBeNull();
});

it('keeps a replayed batch idempotent when the client clock runs ahead', async () => {
  const { app, user, bookId } = await setup();
  const future = new Date(Date.now() + 10 * 60 * 1000).toISOString();
  const batch: SyncPushChange[] = [
    progressChange(bookId, future),
    annotationChange(newId(), bookId, future, '超前'),
    bookmarkChange(newId(), bookId, future, '超前书签'),
  ];

  const first = await push(app, user, batch);
  expect(first.json().applied).toHaveLength(3);

  const replay = await push(app, user, batch);
  expect(replay.json().applied).toEqual([]);
  expect(replay.json().skipped).toHaveLength(3);

  const { rows } = await testDb.$client.query<{ count: string }>(
    'select count(*) from sync_changes where user_id = $1',
    [user.id],
  );
  expect(Number(rows[0]?.count)).toBe(3);
});

it('applies an equal timestamp when the payload changed', async () => {
  const { app, user, bookId } = await setup();
  const annotationId = newId();

  await push(app, user, [annotationChange(annotationId, bookId, T1, '第一版')]);
  const changed = await push(app, user, [annotationChange(annotationId, bookId, T1, '另一版')]);

  expect(changed.json().applied).toHaveLength(1);
  const history = await testDb.select().from(annotationHistory);
  expect(history.map((entry) => entry.noteText)).toEqual(['第一版']);
  const [row] = await testDb.select().from(annotations);
  expect(row).toMatchObject({ noteText: '另一版', revision: 2 });
});

it('rejects deletes of progress and settings', async () => {
  const { app, user, bookId } = await setup();

  const progressDelete = await push(app, user, [
    { entityType: 'reading_progress', entityId: bookId, op: 'delete', clientUpdatedAt: T1 },
  ]);
  expect(progressDelete.json().rejected).toEqual([
    { key: syncKey('reading_progress', bookId), reason: 'unsupported_op' },
  ]);

  const settingsDelete = await push(app, user, [
    { entityType: 'reader_settings', entityId: user.id, op: 'delete', clientUpdatedAt: T1 },
  ]);
  expect(settingsDelete.json().rejected).toEqual([
    { key: syncKey('reader_settings', user.id), reason: 'unsupported_op' },
  ]);
});

it('propagates a bookmark delete as a tombstone that a newer upsert resurrects', async () => {
  const { app, user, bookId } = await setup();
  const bookmarkId = newId();

  await push(app, user, [bookmarkChange(bookmarkId, bookId, T1, '删除我')]);
  const deleted = await push(app, user, [
    { entityType: 'bookmark', entityId: bookmarkId, op: 'delete', clientUpdatedAt: T2 },
  ]);
  expect(deleted.json().applied[0]).toMatchObject({
    entityType: 'bookmark',
    entityId: bookmarkId,
    op: 'delete',
    payload: { label: '删除我' },
  });

  const list = await app.inject({
    method: 'GET',
    url: `/api/books/${bookId}/bookmarks`,
    headers: await authHeader(user),
  });
  expect(list.json().items).toEqual([]);

  await push(app, user, [bookmarkChange(bookmarkId, bookId, T3, '复活')]);
  const [row] = await testDb.select().from(bookmarks);
  expect(row).toMatchObject({ label: '复活', deletedAt: null });

  const relisted = await app.inject({
    method: 'GET',
    url: `/api/books/${bookId}/bookmarks`,
    headers: await authHeader(user),
  });
  expect(relisted.json().items).toHaveLength(1);
});

it('rejects pushes without a token', async () => {
  const { app, bookId } = await setup();

  const response = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    payload: { changes: [progressChange(bookId, T1)] },
  });
  expect(response.statusCode).toBe(401);
});

it('skips older reader settings', async () => {
  const { app, user } = await setup();

  await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: user.id,
      op: 'upsert',
      clientUpdatedAt: T2,
      payload: { settings: { theme: 'dark' } },
    },
  ]);
  const stale = await push(app, user, [
    {
      entityType: 'reader_settings',
      entityId: user.id,
      op: 'upsert',
      clientUpdatedAt: T1,
      payload: { settings: { theme: 'light' } },
    },
  ]);

  expect(stale.json().skipped).toEqual([syncKey('reader_settings', user.id)]);
  const [row] = await testDb.select().from(userSettings);
  expect(row?.payload).toEqual({ theme: 'dark' });
});

it('rejects a missing book for annotations and bookmarks', async () => {
  const { app, user } = await setup();
  const missingBookId = newId();
  const annotationId = newId();
  const bookmarkId = newId();

  const annotation = await push(app, user, [
    annotationChange(annotationId, missingBookId, T1, '无书'),
  ]);
  expect(annotation.json().rejected).toEqual([
    { key: syncKey('annotation', annotationId), reason: 'unknown_entity' },
  ]);

  const bookmark = await push(app, user, [bookmarkChange(bookmarkId, missingBookId, T1, '无书')]);
  expect(bookmark.json().rejected).toEqual([
    { key: syncKey('bookmark', bookmarkId), reason: 'unknown_entity' },
  ]);
});

it('rejects a locator of the wrong kind for annotations and bookmarks', async () => {
  const { app, user } = await setup();
  const epub = await seedBook({ uploadedBy: user.id, format: 'epub' });
  const annotationId = newId();
  const bookmarkId = newId();

  const annotation = await push(app, user, [
    annotationChange(annotationId, epub.id, T1, '错位'),
  ]);
  expect(annotation.json().rejected).toEqual([
    { key: syncKey('annotation', annotationId), reason: 'invalid_payload' },
  ]);

  const bookmark = await push(app, user, [bookmarkChange(bookmarkId, epub.id, T1, '错位')]);
  expect(bookmark.json().rejected).toEqual([
    { key: syncKey('bookmark', bookmarkId), reason: 'invalid_payload' },
  ]);
});
