import type {
  AnnotationDto,
  BookmarkDto,
  ReadingProgressDto,
  SyncChangeEnvelope,
  SyncEntityType,
  SyncOp,
} from '@bookr/shared';
import type { Transaction } from '../db/client';
import { appendChange } from './repo';

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
