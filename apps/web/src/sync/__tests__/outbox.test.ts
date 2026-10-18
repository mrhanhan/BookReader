import { newId, type Locator } from '@bookr/shared';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { createSyncDb, type BookrDb } from '../db';
import { acknowledgeOutbox, dropOutboxFor, dueOutbox, enqueue } from '../outbox';
import type { OutboxRow } from '../types';

const USER = 'user-reader';
const OTHER_USER = 'user-other';
const BOOK = '0198f0c0-0000-7000-8000-000000000001';

const locator: Locator = { kind: 'pdf', page: 1, percent: 0.1 };

let counter = 0;
let db: BookrDb;

beforeEach(() => {
  counter += 1;
  db = createSyncDb(`bookr-outbox-test-${counter}`);
});

afterEach(async () => {
  await db.delete();
});

function change(
  overrides: Partial<Omit<OutboxRow, 'attempts' | 'nextAttemptAt'>> = {},
): Omit<OutboxRow, 'attempts' | 'nextAttemptAt'> {
  return {
    id: newId(),
    userId: USER,
    entityType: 'reading_progress',
    entityId: BOOK,
    op: 'upsert',
    payload: { bookId: BOOK, locator },
    clientUpdatedAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('outbox', () => {
  it('enqueues a row that is immediately due', async () => {
    const entry = change();
    await enqueue(db, entry);

    const row = await db.outbox.get(entry.id);
    expect(row).toMatchObject({ ...entry, attempts: 0, nextAttemptAt: 0 });
  });

  it("returns only the user's due rows in index order, capped by limit", async () => {
    const first = change();
    const second = change({ clientUpdatedAt: '2026-01-02T00:00:00.000Z' });
    const third = change();
    await enqueue(db, first);
    await enqueue(db, second);
    await enqueue(db, third);
    await enqueue(db, change({ userId: OTHER_USER }));

    const limited = await dueOutbox(db, USER, 1000, 2);
    expect(limited).toHaveLength(2);
    expect(limited.every((row) => row.userId === USER)).toBe(true);

    const all = await dueOutbox(db, USER, 1000, 10);
    expect(all.map((row) => row.id)).toEqual([first.id, second.id, third.id]);
    expect(await dueOutbox(db, USER, 1000, 0)).toEqual([]);
  });

  it('skips rows whose next attempt is in the future', async () => {
    const entry = change();
    await enqueue(db, entry);
    await db.outbox.update(entry.id, { nextAttemptAt: 5000 });

    expect(await dueOutbox(db, USER, 4999, 10)).toEqual([]);
    expect((await dueOutbox(db, USER, 5000, 10)).map((row) => row.id)).toEqual([entry.id]);
  });

  it('acknowledges rows by id', async () => {
    const first = change();
    const second = change();
    const third = change();
    await enqueue(db, first);
    await enqueue(db, second);
    await enqueue(db, third);

    await acknowledgeOutbox(db, [first.id, second.id]);

    expect(await db.outbox.count()).toBe(1);
    expect(await db.outbox.get(third.id)).toBeDefined();
    await acknowledgeOutbox(db, []);
    expect(await db.outbox.count()).toBe(1);
  });

  it('drops only the rows of one user and entity', async () => {
    const target = change();
    const sameEntityOtherUser = change({ userId: OTHER_USER });
    const otherEntity = change({
      entityType: 'bookmark',
      entityId: '0198f0c0-0000-7000-8000-000000000002',
    });
    await enqueue(db, target);
    await enqueue(db, sameEntityOtherUser);
    await enqueue(db, otherEntity);

    await dropOutboxFor(db, USER, 'reading_progress', BOOK);

    const remaining = (await db.outbox.toArray()).map((row) => row.id).sort();
    expect(remaining).toEqual([sameEntityOtherUser.id, otherEntity.id].sort());
  });
});
