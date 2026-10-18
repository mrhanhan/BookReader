import {
  SYNC_RETENTION_DAYS,
  syncKey,
  type AnnotationDto,
  type BookmarkDto,
  type ReadingProgressDto,
  type SyncChangeEnvelope,
  type SyncEntityType,
  type SyncOp,
  type SyncPullResult,
  type SyncPushChange,
  type SyncPushResult,
  type SyncRejectReason,
  type SyncSnapshot,
} from '@bookr/shared';
import { and, desc, eq, isNull, lt, sql } from 'drizzle-orm';
import type { AppDeps } from '../app';
import type { Transaction } from '../db/client';
import {
  annotations,
  bookmarks,
  readingProgress,
  syncChanges,
  syncMeta,
} from '../db/schema';
import { toAnnotationDto, toBookmarkDto, toProgressDto } from '../reading/dto';
import type { ReadingActor } from '../reading/guards';
import { applyChange } from './apply';
import {
  appendChange,
  listChangesInTx,
  markPrunedThrough,
  maxRevision,
  PRUNED_THROUGH_KEY,
  prunedThroughInTx,
  readUserSettings,
} from './repo';

/** Identity and payload of one change, as built by the helpers below. */
export type SyncPayloadFor = {
  entityType: SyncEntityType;
  entityId: string;
  payload: unknown;
};

/**
 * Canonical state carried by the log for a progress write. The log stores the
 * whole object, unlike push payloads which only carry what the client sent.
 */
export function progressChangePayload(
  dto: ReadingProgressDto,
  clientUpdatedAt: Date,
): unknown {
  return {
    bookId: dto.bookId,
    locator: dto.locator,
    percent: dto.percent,
    updatedAt: dto.updatedAt,
    clientUpdatedAt: clientUpdatedAt.toISOString(),
  };
}

/** Canonical state carried by the log for an annotation write or delete. */
export function annotationChangePayload(
  dto: AnnotationDto,
  clientUpdatedAt: Date,
): unknown {
  return {
    id: dto.id,
    bookId: dto.bookId,
    type: dto.type,
    color: dto.color,
    locator: dto.locator,
    selectedText: dto.selectedText,
    noteText: dto.noteText,
    tags: dto.tags,
    revision: dto.revision,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    clientUpdatedAt: clientUpdatedAt.toISOString(),
  };
}

/** Canonical state carried by the log for a bookmark write or delete. */
export function bookmarkChangePayload(
  dto: BookmarkDto,
  clientUpdatedAt: Date,
): unknown {
  return {
    id: dto.id,
    bookId: dto.bookId,
    locator: dto.locator,
    label: dto.label,
    createdAt: dto.createdAt,
    updatedAt: dto.updatedAt,
    clientUpdatedAt: clientUpdatedAt.toISOString(),
  };
}

/** Canonical state carried by the log for a reader-settings write. */
export function settingsChangePayload(
  settings: Record<string, unknown>,
  clientUpdatedAt: Date,
  updatedAt: Date,
): unknown {
  return {
    settings,
    updatedAt: updatedAt.toISOString(),
    clientUpdatedAt: clientUpdatedAt.toISOString(),
  };
}

/** Appends one change to the caller's transaction; used by every reading write. */
export async function recordChange(
  tx: Transaction,
  input: {
    userId: string;
    entityType: SyncEntityType;
    entityId: string;
    op: SyncOp;
    payload: unknown;
    clientUpdatedAt: Date;
    serverUpdatedAt: Date;
    deviceId?: string | null;
  },
): Promise<SyncChangeEnvelope> {
  return appendChange(tx, input);
}

/**
 * Reads one page of the caller's change log. A cursor older than the retained
 * window is answered with `reset` so the client rebuilds from a snapshot
 * instead of silently missing pruned changes.
 *
 * The returned cursor is the revision of the last change in this page (or
 * `since` when the page is empty). Returning the user's global high-water mark
 * here would let a client with `hasMore: true` skip everything committed after
 * the page, so it only advances as far as this page actually covers.
 */
export async function pullChanges(
  deps: AppDeps,
  userId: string,
  since: number,
  limit: number,
): Promise<SyncPullResult> {
  // Both reads must come from one snapshot. If a prune commits between the
  // watermark read and the page read under READ COMMITTED, revisions in
  // (since, newWatermark] are already deleted but the old watermark still
  // looks valid, so the client neither receives them nor resets: silent loss.
  return deps.db.transaction(
    async (tx) => {
      const watermark = await prunedThroughInTx(tx);

      if (since > 0 && since < watermark) {
        return { changes: [], cursor: since, hasMore: false, reset: true };
      }

      const page = await listChangesInTx(tx, userId, since, limit);
      const cursor = page.rows.at(-1)?.revision ?? since;
      return { changes: page.rows, cursor, hasMore: page.hasMore, reset: false };
    },
    { isolationLevel: 'repeatable read' },
  );
}

/**
 * Builds the full state a device pulls when it cannot resume from a cursor.
 * Only the caller's own live rows are included; soft-deleted entities are
 * represented by the change log instead.
 */
export async function buildSnapshot(deps: AppDeps, userId: string): Promise<SyncSnapshot> {
  const cursor = await maxRevision(deps.db, userId);

  const progressRows = await deps.db
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.userId, userId))
    .orderBy(desc(readingProgress.updatedAt));

  const annotationRows = await deps.db
    .select()
    .from(annotations)
    .where(and(eq(annotations.userId, userId), isNull(annotations.deletedAt)))
    .orderBy(desc(annotations.updatedAt));

  const bookmarkRows = await deps.db
    .select()
    .from(bookmarks)
    .where(and(eq(bookmarks.userId, userId), isNull(bookmarks.deletedAt)))
    .orderBy(desc(bookmarks.createdAt));

  const settings = await readUserSettings(deps.db, userId);

  return {
    cursor,
    progress: progressRows.map((row) =>
      progressChangePayload(toProgressDto(row), row.clientUpdatedAt ?? row.updatedAt),
    ),
    annotations: annotationRows.map((row) =>
      annotationChangePayload(toAnnotationDto(row), row.clientUpdatedAt ?? row.updatedAt),
    ),
    bookmarks: bookmarkRows.map((row) =>
      bookmarkChangePayload(toBookmarkDto(row), row.clientUpdatedAt ?? row.updatedAt),
    ),
    settings: settings
      ? settingsChangePayload(
          settings.payload,
          settings.clientUpdatedAt,
          settings.updatedAt,
        )
      : null,
  };
}

/**
 * Applies a pushed batch in order and reports the caller's new cursor. A
 * rejected change is reported instead of thrown so the rest of the batch still
 * lands; replayed batches produce only skips and no new log rows.
 */
export async function applyPush(
  deps: AppDeps,
  actor: ReadingActor,
  changes: SyncPushChange[],
): Promise<SyncPushResult> {
  const appliedChanges: SyncChangeEnvelope[] = [];
  const skipped: string[] = [];
  const rejected: Array<{ key: string; reason: SyncRejectReason }> = [];

  for (const change of changes) {
    const result = await applyChange(deps, actor, change);
    const key = syncKey(change.entityType, change.entityId);
    if (result.status === 'applied' && result.change) {
      appliedChanges.push(result.change);
      // `applyChange` commits its own transaction before returning, so a
      // listener that pulls immediately can see the row this change describes.
      deps.syncHub.publish(actor.id, result.change);
    } else if (result.status === 'skipped') {
      skipped.push(key);
    } else {
      rejected.push({ key, reason: result.reason ?? 'invalid_payload' });
    }
  }

  // An acknowledgement marker, not a pull cursor: 0 means nothing was applied.
  const cursor = appliedChanges.at(-1)?.revision ?? 0;
  return { applied: appliedChanges, skipped, rejected, cursor };
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Deletes log entries older than the retention window and advances the
 * pruned-through watermark to the newest revision in the deleted batch. The
 * watermark only ever moves forward, so a client that already passed it is
 * never told to reset again.
 */
export async function pruneSyncLog(
  deps: AppDeps,
): Promise<{ pruned: number; through: number }> {
  const cutoff = new Date(deps.clock.now().getTime() - SYNC_RETENTION_DAYS * DAY_MS);
  const expired = lt(syncChanges.createdAt, cutoff);

  return deps.db.transaction(async (tx) => {
    const [stats] = await tx
      .select({
        pruned: sql<number>`count(*)::int`,
        through: sql<string>`coalesce(max(${syncChanges.revision}), 0)`,
      })
      .from(syncChanges)
      .where(expired);

    const pruned = Number(stats?.pruned ?? 0);
    const batchThrough = Number(stats?.through ?? 0);

    if (pruned > 0) {
      await tx.delete(syncChanges).where(expired);
      await markPrunedThrough(tx, batchThrough);
    }

    const [meta] = await tx
      .select()
      .from(syncMeta)
      .where(eq(syncMeta.key, PRUNED_THROUGH_KEY))
      .limit(1);
    return { pruned, through: meta?.value ?? 0 };
  });
}

/**
 * Permanently removes tombstones older than the retention window. Annotation
 * history rows disappear with their annotation through the foreign key.
 */
export async function purgeDeletedEntities(
  deps: AppDeps,
): Promise<{ annotations: number; bookmarks: number }> {
  const cutoff = new Date(deps.clock.now().getTime() - SYNC_RETENTION_DAYS * DAY_MS);

  return deps.db.transaction(async (tx) => {
    const expiredAnnotations = lt(annotations.deletedAt, cutoff);
    const [annotationStats] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(annotations)
      .where(expiredAnnotations);
    const annotationCount = Number(annotationStats?.count ?? 0);
    if (annotationCount > 0) {
      await tx.delete(annotations).where(expiredAnnotations);
    }

    const expiredBookmarks = lt(bookmarks.deletedAt, cutoff);
    const [bookmarkStats] = await tx
      .select({ count: sql<number>`count(*)::int` })
      .from(bookmarks)
      .where(expiredBookmarks);
    const bookmarkCount = Number(bookmarkStats?.count ?? 0);
    if (bookmarkCount > 0) {
      await tx.delete(bookmarks).where(expiredBookmarks);
    }

    return { annotations: annotationCount, bookmarks: bookmarkCount };
  });
}
