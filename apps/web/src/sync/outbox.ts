import type { SyncEntityType } from '@bookr/shared';
import type { BookrDb } from './db';
import type { OutboxRow } from './types';

/**
 * Appends one unsent mutation. New rows are immediately due; the sync engine
 * owns retry accounting through `attempts` and `nextAttemptAt`.
 */
export async function enqueue(
  db: BookrDb,
  change: Omit<OutboxRow, 'attempts' | 'nextAttemptAt'>,
): Promise<void> {
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

/** Removes rows the server has accepted (or rejected). */
export async function acknowledgeOutbox(db: BookrDb, ids: string[]): Promise<void> {
  if (ids.length === 0) {
    return;
  }

  await db.outbox.bulkDelete(ids);
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
