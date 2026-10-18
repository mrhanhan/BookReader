import type { SyncChangeEnvelope } from '@bookr/shared';
import { and, eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { annotations, bookmarks, readingProgress } from '../src/db/schema';
import {
  appendChange,
  markPrunedThrough,
  upsertUserSettings,
  type AppendChangeInput,
} from '../src/sync/repo';
import {
  authHeader,
  buildTestApp,
  resetDb,
  seedAnnotation,
  seedBook,
  seedBookmark,
  seedProgress,
  seedUser,
  testDb,
} from './helpers';

const locator = { kind: 'pdf' as const, page: 3, percent: 0.4 };

async function appendChangeInTx(input: AppendChangeInput): Promise<SyncChangeEnvelope> {
  return testDb.transaction((tx) => appendChange(tx, input));
}

function changeInput(userId: string, entityId: string, at: Date = new Date()): AppendChangeInput {
  return {
    userId,
    entityType: 'bookmark',
    entityId,
    op: 'upsert',
    payload: { id: entityId },
    clientUpdatedAt: at,
    serverUpdatedAt: at,
  };
}

it('pulls incrementally by cursor', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const first = await appendChangeInTx(changeInput(user.id, 'one'));
  const second = await appendChangeInTx(changeInput(user.id, 'two'));
  const third = await appendChangeInTx(changeInput(user.id, 'three'));
  const headers = await authHeader(user);

  const page = await app.inject({
    method: 'GET',
    url: '/api/sync/pull?since=0&limit=2',
    headers,
  });
  expect(page.statusCode).toBe(200);
  expect(page.json()).toMatchObject({
    cursor: second.revision,
    hasMore: true,
    reset: false,
    changes: [{ revision: first.revision }, { revision: second.revision }],
  });

  const next = await app.inject({
    method: 'GET',
    url: `/api/sync/pull?since=${second.revision}`,
    headers,
  });
  expect(next.json()).toMatchObject({
    cursor: third.revision,
    hasMore: false,
    reset: false,
    changes: [{ revision: third.revision }],
  });

  const empty = await app.inject({
    method: 'GET',
    url: `/api/sync/pull?since=${third.revision}`,
    headers,
  });
  expect(empty.json()).toEqual({
    changes: [],
    cursor: third.revision,
    hasMore: false,
    reset: false,
  });
});

it('returns reset when the cursor predates the retention watermark', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  await testDb.transaction((tx) => markPrunedThrough(tx, 5));
  await appendChangeInTx(changeInput(user.id, 'kept'));

  const response = await app.inject({
    method: 'GET',
    url: '/api/sync/pull?since=2',
    headers: await authHeader(user),
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    changes: [],
    cursor: 2,
    hasMore: false,
    reset: true,
  });

  // A fresh device starts at 0; with pruned history it cannot replay the log
  // from the beginning, so it must snapshot too instead of missing old rows.
  const fromStart = await app.inject({
    method: 'GET',
    url: '/api/sync/pull?since=0',
    headers: await authHeader(user),
  });
  expect(fromStart.json()).toEqual({
    changes: [],
    cursor: 0,
    hasMore: false,
    reset: true,
  });
});

it('snapshots live entities only and includes the cursor', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const older = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const newer = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  await seedProgress({
    userId: user.id,
    bookId: older.id,
    locator,
    updatedAt: new Date('2026-10-17T00:00:00.000Z'),
  });
  await seedProgress({
    userId: user.id,
    bookId: newer.id,
    locator,
    updatedAt: new Date('2026-10-18T00:00:00.000Z'),
  });
  const liveAnnotation = await seedAnnotation({
    userId: user.id,
    bookId: newer.id,
    noteText: '保留',
  });
  await seedAnnotation({
    userId: user.id,
    bookId: newer.id,
    noteText: '已删',
    deletedAt: new Date('2026-10-18T01:00:00.000Z'),
  });
  const liveBookmark = await seedBookmark({ userId: user.id, bookId: newer.id, label: '保留' });
  await seedBookmark({
    userId: user.id,
    bookId: newer.id,
    label: '已删',
    deletedAt: new Date('2026-10-18T01:00:00.000Z'),
  });
  await testDb.transaction((tx) =>
    upsertUserSettings(tx, {
      userId: user.id,
      payload: { theme: 'dark' },
      clientUpdatedAt: new Date('2026-10-18T00:00:00.000Z'),
      updatedAt: new Date('2026-10-18T00:00:00.000Z'),
    }),
  );

  // The snapshot cursor is the caller's latest revision, not a reset value.
  const logged = await appendChangeInTx(changeInput(user.id, 'last-change'));

  const response = await app.inject({
    method: 'GET',
    url: '/api/sync/snapshot',
    headers: await authHeader(user),
  });
  expect(response.statusCode).toBe(200);
  const snapshot = response.json();

  expect(snapshot).toMatchObject({
    cursor: logged.revision,
    progress: [
      { bookId: newer.id, locator, percent: locator.percent },
      { bookId: older.id, locator, percent: locator.percent },
    ],
    annotations: [{ id: liveAnnotation.id, noteText: '保留' }],
    bookmarks: [{ id: liveBookmark.id, label: '保留' }],
    settings: { settings: { theme: 'dark' } },
  });
  expect(snapshot.settings).toMatchObject({
    settings: { theme: 'dark' },
    clientUpdatedAt: '2026-10-18T00:00:00.000Z',
  });
  expect(
    (await testDb.select().from(annotations)).filter((row) => row.deletedAt !== null),
  ).toHaveLength(1);
  expect(snapshot.annotations).toHaveLength(1);
  expect(snapshot.bookmarks).toHaveLength(1);
});

it("does not leak another user's snapshot", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });
  await seedProgress({ userId: alice.id, bookId: book.id, locator });
  await seedProgress({ userId: bob.id, bookId: book.id, locator });
  const aliceNote = await seedAnnotation({ userId: alice.id, bookId: book.id, noteText: 'A' });
  await seedAnnotation({ userId: bob.id, bookId: book.id, noteText: 'B' });
  const aliceMark = await seedBookmark({ userId: alice.id, bookId: book.id, label: 'A' });
  await seedBookmark({ userId: bob.id, bookId: book.id, label: 'B' });
  await testDb.transaction((tx) =>
    upsertUserSettings(tx, {
      userId: bob.id,
      payload: { theme: 'dark' },
      clientUpdatedAt: new Date(),
      updatedAt: new Date(),
    }),
  );

  const response = await app.inject({
    method: 'GET',
    url: '/api/sync/snapshot',
    headers: await authHeader(alice),
  });

  expect(response.json().progress).toHaveLength(1);
  expect(response.json().annotations.map((row: { id: string }) => row.id)).toEqual([aliceNote.id]);
  expect(response.json().bookmarks.map((row: { id: string }) => row.id)).toEqual([aliceMark.id]);
  expect(response.json().settings).toBeNull();

  const stored = await testDb
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, bob.id), eq(readingProgress.bookId, book.id)));
  expect(stored).toHaveLength(1);
  expect((await testDb.select().from(bookmarks)).length).toBe(2);
});

it('rejects an unauthenticated pull', async () => {
  await resetDb();
  const app = await buildTestApp();

  expect((await app.inject({ method: 'GET', url: '/api/sync/pull' })).statusCode).toBe(401);
  expect((await app.inject({ method: 'GET', url: '/api/sync/snapshot' })).statusCode).toBe(401);
});

it('pins the snapshot cursor above the global prune watermark', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  await testDb.transaction((tx) => markPrunedThrough(tx, 10));
  const logged = await appendChangeInTx(changeInput(user.id, 'below-watermark'));
  expect(logged.revision).toBeLessThan(10);

  const headers = await authHeader(user);
  const snapshot = await app.inject({ method: 'GET', url: '/api/sync/snapshot', headers });
  expect(snapshot.statusCode).toBe(200);
  // The user's own max revision is below the watermark; the snapshot must
  // still land above it or the next pull would reset again, forever.
  expect(snapshot.json().cursor).toBe(10);

  const pull = await app.inject({
    method: 'GET',
    url: `/api/sync/pull?since=${snapshot.json().cursor}`,
    headers,
  });
  expect(pull.json()).toEqual({
    changes: [],
    cursor: 10,
    hasMore: false,
    reset: false,
  });
});
