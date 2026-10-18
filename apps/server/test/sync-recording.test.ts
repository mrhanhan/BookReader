import { expect, it } from 'vitest';
import { annotations, bookmarks, readingProgress } from '../src/db/schema';
import { createAnnotation, deleteAnnotation, updateAnnotation } from '../src/reading/annotations';
import { createBookmark, deleteBookmark, updateBookmark } from '../src/reading/bookmarks';
import { saveProgress } from '../src/reading/progress';
import { listChanges } from '../src/sync/repo';
import { buildTestDeps, resetDb, seedBook, seedUser, testDb } from './helpers';

const locator = { kind: 'pdf' as const, page: 3, percent: 0.4 };

it('records a canonical progress change on save', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const deps = await buildTestDeps();

  await saveProgress(deps, { id: user.id, deviceId: user.deviceId }, book.id, locator);

  const page = await listChanges(testDb, user.id, 0, 10);
  expect(page.rows).toHaveLength(1);
  expect(page.rows[0]).toMatchObject({
    entityType: 'reading_progress',
    entityId: book.id,
    op: 'upsert',
    payload: { bookId: book.id, locator, percent: locator.percent },
  });

  const envelope = page.rows[0]!;
  expect(envelope.payload).toMatchObject({
    updatedAt: envelope.serverUpdatedAt,
    clientUpdatedAt: envelope.clientUpdatedAt,
  });

  const [row] = await testDb.select().from(readingProgress);
  expect(row?.clientUpdatedAt).toBeInstanceOf(Date);
});

it('records create, update and delete for annotations', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const deps = await buildTestDeps();
  const actor = { id: user.id, deviceId: user.deviceId };

  const created = await createAnnotation(deps, actor, book.id, {
    type: 'note',
    color: 'yellow',
    locator,
    selectedText: '原文',
    noteText: '第一版想法',
    tags: ['想法'],
  });
  const updated = await updateAnnotation(deps, actor, book.id, created.id, {
    revision: 1,
    noteText: '第二版想法',
  });
  expect(updated.conflict).toBe(false);
  await deleteAnnotation(deps, actor, book.id, created.id);

  const page = await listChanges(testDb, user.id, 0, 10);
  expect(page.rows.map((row) => [row.entityType, row.entityId, row.op])).toEqual([
    ['annotation', created.id, 'upsert'],
    ['annotation', created.id, 'upsert'],
    ['annotation', created.id, 'delete'],
  ]);
  expect(page.rows[0]?.payload).toMatchObject({
    id: created.id,
    bookId: book.id,
    type: 'note',
    color: 'yellow',
    locator,
    selectedText: '原文',
    noteText: '第一版想法',
    tags: ['想法'],
    revision: 1,
  });
  expect(page.rows[1]?.payload).toMatchObject({ noteText: '第二版想法', revision: 2 });
  expect(page.rows[2]?.payload).toMatchObject({ noteText: '第二版想法', revision: 2 });

  const [row] = await testDb.select().from(annotations);
  expect(row?.clientUpdatedAt).toBeInstanceOf(Date);
});

it("records bookmarks and never records another user's rows", async () => {
  await resetDb();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const book = await seedBook({ uploadedBy: alice.id, format: 'pdf' });
  const deps = await buildTestDeps();
  const aliceActor = { id: alice.id, deviceId: alice.deviceId };
  const bobActor = { id: bob.id, deviceId: bob.deviceId };

  const created = await createBookmark(deps, aliceActor, book.id, { locator, label: '起点' });
  await updateBookmark(deps, aliceActor, book.id, created.id, { label: '重读此处' });
  await deleteBookmark(deps, aliceActor, book.id, created.id);
  await createBookmark(deps, bobActor, book.id, { locator, label: 'B 的书签' });

  const page = await listChanges(testDb, alice.id, 0, 10);
  expect(page.rows.map((row) => [row.entityType, row.entityId, row.op])).toEqual([
    ['bookmark', created.id, 'upsert'],
    ['bookmark', created.id, 'upsert'],
    ['bookmark', created.id, 'delete'],
  ]);
  expect(page.rows[0]?.payload).toMatchObject({
    id: created.id,
    bookId: book.id,
    locator,
    label: '起点',
  });
  expect(page.rows[2]?.payload).toMatchObject({ label: '重读此处' });

  const bobPage = await listChanges(testDb, bob.id, 0, 10);
  expect(bobPage.rows).toHaveLength(1);
  expect(bobPage.rows[0]?.payload).toMatchObject({ label: 'B 的书签' });
  expect(page.rows.map((row) => row.revision)).not.toContain(bobPage.rows[0]?.revision);

  const [row] = await testDb.select().from(bookmarks);
  expect(row?.clientUpdatedAt).toBeInstanceOf(Date);
});
