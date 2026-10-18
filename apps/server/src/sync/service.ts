import type {
  AnnotationDto,
  BookmarkDto,
  ReadingProgressDto,
  SyncChangeEnvelope,
  SyncEntityType,
  SyncOp,
  SyncPullResult,
  SyncSnapshot,
} from '@bookr/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app';
import type { Transaction } from '../db/client';
import { annotations, bookmarks, readingProgress } from '../db/schema';
import { toAnnotationDto, toBookmarkDto, toProgressDto } from '../reading/dto';
import {
  appendChange,
  listChanges,
  maxRevision,
  prunedThrough,
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
 */
export async function pullChanges(
  deps: AppDeps,
  userId: string,
  since: number,
  limit: number,
): Promise<SyncPullResult> {
  const cursor = await maxRevision(deps.db);
  const watermark = await prunedThrough(deps.db);

  if (since > 0 && since < watermark) {
    return { changes: [], cursor, hasMore: false, reset: true };
  }

  const page = await listChanges(deps.db, userId, since, limit);
  return { changes: page.rows, cursor, hasMore: page.hasMore, reset: false };
}

/**
 * Builds the full state a device pulls when it cannot resume from a cursor.
 * Only the caller's own live rows are included; soft-deleted entities are
 * represented by the change log instead.
 */
export async function buildSnapshot(deps: AppDeps, userId: string): Promise<SyncSnapshot> {
  const cursor = await maxRevision(deps.db);

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
          settings.clientUpdatedAt,
        )
      : null,
  };
}
