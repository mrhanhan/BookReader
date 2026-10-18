import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { annotationHistory, annotations, bookmarks, syncChanges } from '../src/db/schema';
import {
  appendChange,
  markPrunedThrough,
  prunedThrough,
  type AppendChangeInput,
} from '../src/sync/repo';
import { pruneSyncLog, purgeDeletedEntities, pullChanges } from '../src/sync/service';
import {
  buildTestDeps,
  resetDb,
  seedAnnotation,
  seedBook,
  seedBookmark,
  seedUser,
  testDb,
} from './helpers';

const DAY_MS = 24 * 60 * 60 * 1000;

function daysAgo(days: number): Date {
  return new Date(Date.now() - days * DAY_MS);
}

async function appendChangeCreatedAt(
  userId: string,
  createdAt: Date,
  entityId: string,
): Promise<number> {
  const input: AppendChangeInput = {
    userId,
    entityType: 'bookmark',
    entityId,
    op: 'upsert',
    payload: { id: entityId },
    clientUpdatedAt: createdAt,
    serverUpdatedAt: createdAt,
  };
  const envelope = await testDb.transaction((tx) => appendChange(tx, input));
  await testDb
    .update(syncChanges)
    .set({ createdAt })
    .where(eq(syncChanges.revision, envelope.revision));
  return envelope.revision;
}

it('prunes the log past the retention window and advances the watermark', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');

  const firstOldRevision = await appendChangeCreatedAt(user.id, daysAgo(100), 'old-1');
  const secondOldRevision = await appendChangeCreatedAt(user.id, daysAgo(91), 'old-2');
  const recentRevision = await appendChangeCreatedAt(user.id, daysAgo(10), 'recent');

  const result = await pruneSyncLog(deps);

  expect(result.pruned).toBe(2);
  expect(result.through).toBe(secondOldRevision);
  expect(await prunedThrough(testDb)).toBe(secondOldRevision);

  const rows = await testDb.select().from(syncChanges);
  expect(rows.map((row) => row.revision)).toEqual([recentRevision]);

  const pull = await pullChanges(deps, user.id, firstOldRevision, 10);
  expect(pull).toEqual({
    changes: [],
    cursor: firstOldRevision,
    hasMore: false,
    reset: true,
  });

  // A second sweep finds nothing and leaves the watermark alone.
  const again = await pruneSyncLog(deps);
  expect(again).toEqual({ pruned: 0, through: secondOldRevision });
});

it('never lowers the prune watermark', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');

  await testDb.transaction((tx) => markPrunedThrough(tx, 42));
  await appendChangeCreatedAt(user.id, daysAgo(200), 'very-old');

  const result = await pruneSyncLog(deps);
  expect(result.pruned).toBe(1);
  expect(result.through).toBe(42);
  expect(await prunedThrough(testDb)).toBe(42);
});

it('hard-deletes tombstones older than 90 days but keeps newer ones', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });

  const oldAnnotation = await seedAnnotation({
    userId: user.id,
    bookId: book.id,
    noteText: '旧',
    deletedAt: daysAgo(91),
  });
  const recentAnnotation = await seedAnnotation({
    userId: user.id,
    bookId: book.id,
    noteText: '新',
    deletedAt: daysAgo(10),
  });
  const liveAnnotation = await seedAnnotation({
    userId: user.id,
    bookId: book.id,
    noteText: '活',
    updatedAt: daysAgo(200),
  });
  await testDb.insert(annotationHistory).values({
    annotationId: oldAnnotation.id,
    noteText: '更早',
    editedAt: daysAgo(95),
  });
  const recentBookmark = await seedBookmark({
    userId: user.id,
    bookId: book.id,
    label: '新',
    deletedAt: daysAgo(5),
  });
  await seedBookmark({
    userId: user.id,
    bookId: book.id,
    label: '旧',
    deletedAt: daysAgo(120),
  });

  const result = await purgeDeletedEntities(deps);
  expect(result).toEqual({ annotations: 1, bookmarks: 1 });

  const remainingAnnotations = await testDb.select().from(annotations);
  expect(remainingAnnotations.map((row) => row.id).sort()).toEqual(
    [recentAnnotation.id, liveAnnotation.id].sort(),
  );
  expect((await testDb.select().from(annotationHistory)).length).toBe(0);

  const remainingBookmarks = await testDb.select().from(bookmarks);
  expect(remainingBookmarks.map((row) => row.id)).toEqual([recentBookmark.id]);
});
