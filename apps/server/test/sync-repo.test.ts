import type { SyncChangeEnvelope } from '@bookr/shared';
import { expect, it } from 'vitest';
import { userSettings } from '../src/db/schema';
import {
  appendChange,
  listChanges,
  markPrunedThrough,
  maxRevision,
  prunedThrough,
  readUserSettings,
  upsertUserSettings,
  type AppendChangeInput,
} from '../src/sync/repo';
import { resetDb, seedUser, testDb } from './helpers';

const NOW = new Date('2026-10-18T00:00:00.000Z');

async function appendChangeInTx(input: AppendChangeInput): Promise<SyncChangeEnvelope> {
  return testDb.transaction((tx) => appendChange(tx, input));
}

async function markPrunedThroughInTx(revision: number): Promise<void> {
  await testDb.transaction((tx) => markPrunedThrough(tx, revision));
}

function changeInput(userId: string, overrides: Partial<AppendChangeInput> = {}): AppendChangeInput {
  return {
    userId,
    entityType: 'reading_progress',
    entityId: 'book-1',
    op: 'upsert',
    payload: {},
    clientUpdatedAt: NOW,
    serverUpdatedAt: NOW,
    ...overrides,
  };
}

it('appends changes in revision order per user', async () => {
  await resetDb();
  const user = await seedUser('member');
  const payload = { bookId: 'book-1', locator: { kind: 'pdf', page: 3, percent: 0.2 } };

  const first = await appendChangeInTx(
    changeInput(user.id, { payload }),
  );
  const second = await appendChangeInTx(
    changeInput(user.id, { entityType: 'annotation', entityId: 'annotation-1' }),
  );

  expect(second.revision).toBeGreaterThan(first.revision);

  const page = await listChanges(testDb, user.id, 0, 10);
  expect(page.rows.map((row) => row.revision)).toEqual([first.revision, second.revision]);
  expect(page.hasMore).toBe(false);
  expect(page.rows[0]).toEqual({
    revision: first.revision,
    entityType: 'reading_progress',
    entityId: 'book-1',
    op: 'upsert',
    payload,
    clientUpdatedAt: NOW.toISOString(),
    serverUpdatedAt: NOW.toISOString(),
  });
});

it('paginates with hasMore', async () => {
  await resetDb();
  const user = await seedUser('member');

  const first = await appendChangeInTx(changeInput(user.id, { entityId: 'book-1' }));
  const second = await appendChangeInTx(changeInput(user.id, { entityId: 'book-2' }));
  const third = await appendChangeInTx(changeInput(user.id, { entityId: 'book-3' }));

  const page = await listChanges(testDb, user.id, 0, 2);
  expect(page.rows.map((row) => row.revision)).toEqual([first.revision, second.revision]);
  expect(page.hasMore).toBe(true);

  const next = await listChanges(testDb, user.id, second.revision, 2);
  expect(next.rows.map((row) => row.revision)).toEqual([third.revision]);
  expect(next.hasMore).toBe(false);

  expect(await maxRevision(testDb, user.id)).toBe(third.revision);
});

it('scopes the revision high-water mark to one user', async () => {
  await resetDb();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');

  const aliceChange = await appendChangeInTx(changeInput(alice.id, { entityId: 'alice-book' }));
  const bobChange = await appendChangeInTx(changeInput(bob.id, { entityId: 'bob-book' }));

  expect(bobChange.revision).toBeGreaterThan(aliceChange.revision);
  expect(await maxRevision(testDb, alice.id)).toBe(aliceChange.revision);
  expect(await maxRevision(testDb, bob.id)).toBe(bobChange.revision);
});

it("never returns another user's changes", async () => {
  await resetDb();
  const alice = await seedUser('member');
  const bob = await seedUser('member');

  await appendChangeInTx(changeInput(alice.id, { entityId: 'alice-book' }));
  await appendChangeInTx(changeInput(bob.id, { entityId: 'bob-book' }));

  const page = await listChanges(testDb, alice.id, 0, 10);
  expect(page.rows.map((row) => row.entityId)).toEqual(['alice-book']);
});

it('reads and writes the pruned-through watermark', async () => {
  await resetDb();
  expect(await prunedThrough(testDb)).toBe(0);

  await markPrunedThroughInTx(42);
  expect(await prunedThrough(testDb)).toBe(42);

  await markPrunedThroughInTx(84);
  expect(await prunedThrough(testDb)).toBe(84);

  await markPrunedThroughInTx(42);
  expect(await prunedThrough(testDb)).toBe(84);
});

it('upserts user settings in place', async () => {
  await resetDb();
  const user = await seedUser('member');
  const other = await seedUser('member');
  const firstAt = new Date('2026-10-17T00:00:00.000Z');
  const secondAt = new Date('2026-10-18T00:00:00.000Z');

  await testDb.transaction((tx) =>
    upsertUserSettings(tx, {
      userId: user.id,
      payload: { theme: 'light' },
      clientUpdatedAt: firstAt,
      updatedAt: firstAt,
    }),
  );
  await testDb.transaction((tx) =>
    upsertUserSettings(tx, {
      userId: user.id,
      payload: { theme: 'dark', fontSize: 18 },
      clientUpdatedAt: secondAt,
      updatedAt: secondAt,
    }),
  );

  const rows = await testDb.select().from(userSettings);
  expect(rows).toHaveLength(1);
  expect(await readUserSettings(testDb, user.id)).toEqual({
    payload: { theme: 'dark', fontSize: 18 },
    clientUpdatedAt: secondAt,
    updatedAt: secondAt,
  });
  expect(await readUserSettings(testDb, other.id)).toBeNull();
});
