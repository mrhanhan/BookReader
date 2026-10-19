import type { SyncEntityType } from '@bookr/shared';
import type { BookrDb } from './db';
import type { OutboxRow } from './types';

/**
 * Appends one unsent mutation. New rows are immediately due; the sync engine
 * owns retry accounting through `attempts` and `nextAttemptAt`.
 *
 * Reading progress is a single position per book and a reading session is a
 * cumulative heartbeat, so a queued upsert is updated in place: a burst of
 * page turns or thirty-second beats then travels as one row carrying the
 * newest values instead of a backlog of stale positions.
 */
export async function enqueue(
  db: BookrDb,
  change: Omit<OutboxRow, 'attempts' | 'nextAttemptAt'>,
): Promise<void> {
  const mergeable =
    change.op === 'upsert' &&
    (change.entityType === 'reading_progress' || change.entityType === 'reading_session');
  if (mergeable) {
    const existing = await db.outbox
      .where('userId')
      .equals(change.userId)
      .filter(
        (row) =>
          row.entityType === change.entityType &&
          row.entityId === change.entityId &&
          row.op === 'upsert',
      )
      .first();
    if (existing !== undefined) {
      await db.outbox.update(existing.id, {
        payload: change.payload,
        clientUpdatedAt: change.clientUpdatedAt,
        // The row now carries a fresh mutation, so a previous failure must not
        // keep it waiting behind the old backoff.
        attempts: 0,
        nextAttemptAt: 0,
      });
      return;
    }
  }

  await db.outbox.put({ ...change, attempts: 0, nextAttemptAt: 0 });
}

/** Rows of one user whose retry time has come, oldest attempt first. */
export async function dueOutbox(
  db: BookrDb,
  userId: string,
  now: number,
  limit: number,
): Promise<OutboxRow[]> {
  if (limit <= 0) {
    return [];
  }

  return db.outbox
    .where('[userId+nextAttemptAt]')
    .between([userId, -Infinity], [userId, now], true, true)
    .limit(limit)
    .toArray();
}

/**
 * Removes rows the server has accepted (or rejected).
 *
 * A queued progress upsert is merged in place, so the row a batch carried may
 * have been updated while that batch was on the wire. Such a row is left for
 * the next push: the server has not seen its newer payload yet.
 */
export async function acknowledgeOutbox(db: BookrDb, rows: OutboxRow[]): Promise<void> {
  if (rows.length === 0) {
    return;
  }

  await db.transaction('rw', db.outbox, async () => {
    const ids: string[] = [];
    for (const row of rows) {
      const current = await db.outbox.get(row.id);
      if (current === undefined) {
        continue;
      }
      if (
        current.clientUpdatedAt === row.clientUpdatedAt &&
        JSON.stringify(current.payload) === JSON.stringify(row.payload)
      ) {
        ids.push(row.id);
      }
    }

    if (ids.length > 0) {
      await db.outbox.bulkDelete(ids);
    }
  });
}

/** Drops every queued mutation of one entity, used when the server wins. */
export async function dropOutboxFor(
  db: BookrDb,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
): Promise<void> {
  await db.outbox
    .where('userId')
    .equals(userId)
    .filter((row) => row.entityType === entityType && row.entityId === entityId)
    .delete();
}
