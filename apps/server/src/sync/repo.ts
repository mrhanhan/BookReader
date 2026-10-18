import type { SyncChangeEnvelope, SyncEntityType, SyncOp } from '@bookr/shared';
import { and, asc, eq, gt, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { syncChanges, syncMeta, userSettings } from '../db/schema';

/** Key of the revision watermark below which the log has been pruned. */
export const PRUNED_THROUGH_KEY = 'pruned_through';

/** Fields written when one change is appended to a user's log. */
export interface AppendChangeInput {
  userId: string;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  clientUpdatedAt: Date;
  serverUpdatedAt: Date;
  deviceId?: string | null;
}

type SyncChangeRow = typeof syncChanges.$inferSelect;

/** Maps a stored row to the wire envelope; payloads pass through untouched. */
function toEnvelope(row: SyncChangeRow): SyncChangeEnvelope {
  return {
    revision: row.revision,
    entityType: row.entityType,
    entityId: row.entityId,
    op: row.op,
    payload: row.payload,
    clientUpdatedAt: row.clientUpdatedAt.toISOString(),
    serverUpdatedAt: row.serverUpdatedAt.toISOString(),
  };
}

/**
 * Serializes writes to one user's change log for the rest of the transaction.
 * Advisory locks are reentrant, so `appendChange` may take the same lock again.
 */
export async function lockUserChanges(tx: Transaction, userId: string): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${userId}))`);
}

/**
 * Appends one accepted change and returns its envelope. The user-scoped
 * advisory lock makes revisions visible per user in commit order, so a client
 * cursor can never jump over a transaction that commits later.
 */
export async function appendChange(
  tx: Transaction,
  input: AppendChangeInput,
): Promise<SyncChangeEnvelope> {
  await lockUserChanges(tx, input.userId);

  const [row] = await tx
    .insert(syncChanges)
    .values({
      userId: input.userId,
      entityType: input.entityType,
      entityId: input.entityId,
      op: input.op,
      payload: input.payload,
      clientUpdatedAt: input.clientUpdatedAt,
      serverUpdatedAt: input.serverUpdatedAt,
      deviceId: input.deviceId ?? null,
    })
    .returning();

  if (!row) {
    throw new Error('Sync change insert returned no row');
  }
  return toEnvelope(row);
}

/**
 * Reads one page of a user's log after `since`, oldest first. It fetches one
 * extra row so the caller knows whether another page exists.
 */
export async function listChanges(
  db: Database,
  userId: string,
  since: number,
  limit: number,
): Promise<{ rows: SyncChangeEnvelope[]; hasMore: boolean }> {
  const rows = await db
    .select()
    .from(syncChanges)
    .where(and(eq(syncChanges.userId, userId), gt(syncChanges.revision, since)))
    .orderBy(asc(syncChanges.revision))
    .limit(limit + 1);

  return shapePage(rows, limit);
}

/** Same read as `listChanges`, but shares the caller's transaction snapshot. */
export async function listChangesInTx(
  tx: Transaction,
  userId: string,
  since: number,
  limit: number,
): Promise<{ rows: SyncChangeEnvelope[]; hasMore: boolean }> {
  const rows = await tx
    .select()
    .from(syncChanges)
    .where(and(eq(syncChanges.userId, userId), gt(syncChanges.revision, since)))
    .orderBy(asc(syncChanges.revision))
    .limit(limit + 1);

  return shapePage(rows, limit);
}

/** Keeps one extra row only to signal that another page exists. */
function shapePage(
  rows: SyncChangeRow[],
  limit: number,
): { rows: SyncChangeEnvelope[]; hasMore: boolean } {
  return {
    rows: rows.slice(0, limit).map(toEnvelope),
    hasMore: rows.length > limit,
  };
}

/** Returns the newest revision in one user's log, or 0 when it is empty. */
export async function maxRevision(db: Database, userId: string): Promise<number> {
  const [row] = await db
    .select({ value: sql<string>`coalesce(max(${syncChanges.revision}), 0)` })
    .from(syncChanges)
    .where(eq(syncChanges.userId, userId));
  return Number(row?.value ?? 0);
}

/** Returns the highest revision clients no longer need to pull, or 0. */
export async function prunedThrough(db: Database): Promise<number> {
  const [row] = await db
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, PRUNED_THROUGH_KEY))
    .limit(1);
  return row?.value ?? 0;
}

/** Reads the prune watermark inside the caller's transaction snapshot. */
export async function prunedThroughInTx(tx: Transaction): Promise<number> {
  const [row] = await tx
    .select()
    .from(syncMeta)
    .where(eq(syncMeta.key, PRUNED_THROUGH_KEY))
    .limit(1);
  return row?.value ?? 0;
}

/** Moves the pruned-through watermark forward, never backward. */
export async function markPrunedThrough(tx: Transaction, revision: number): Promise<void> {
  await tx
    .insert(syncMeta)
    .values({ key: PRUNED_THROUGH_KEY, value: revision })
    .onConflictDoUpdate({
      target: syncMeta.key,
      set: { value: sql`greatest(${syncMeta.value}, ${revision})` },
    });
}

/** Loads a user's synced reader settings, or null when they never saved any. */
export async function readUserSettings(
  db: Database,
  userId: string,
): Promise<{
  payload: Record<string, unknown>;
  clientUpdatedAt: Date;
  updatedAt: Date;
} | null> {
  const [row] = await db
    .select()
    .from(userSettings)
    .where(eq(userSettings.userId, userId))
    .limit(1);

  if (!row) {
    return null;
  }
  return {
    payload: row.payload,
    clientUpdatedAt: row.clientUpdatedAt,
    updatedAt: row.updatedAt,
  };
}

/** Replaces a user's synced reader settings in place. */
export async function upsertUserSettings(
  tx: Transaction,
  input: {
    userId: string;
    payload: Record<string, unknown>;
    clientUpdatedAt: Date;
    updatedAt: Date;
  },
): Promise<void> {
  await tx
    .insert(userSettings)
    .values(input)
    .onConflictDoUpdate({
      target: userSettings.userId,
      set: {
        payload: input.payload,
        clientUpdatedAt: input.clientUpdatedAt,
        updatedAt: input.updatedAt,
      },
    });
}
