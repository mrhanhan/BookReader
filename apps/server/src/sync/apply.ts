import {
  SYNC_CLOCK_SKEW_MS,
  normalizeTags,
  syncAnnotationPayloadSchema,
  syncBookmarkPayloadSchema,
  syncProgressPayloadSchema,
  syncSettingsPayloadSchema,
  type SyncChangeEnvelope,
  type SyncPushChange,
  type SyncRejectReason,
} from '@bookr/shared';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { findBookById } from '../books/repo';
import { readingProgress, userSettings, type AnnotationRow, type BookmarkRow } from '../db/schema';
import { AppError } from '../errors';
import { toAnnotationDto, toBookmarkDto, toProgressDto } from '../reading/dto';
import { assertLocatorKind, type ReadingActor } from '../reading/guards';
import {
  findAnnotationRowById,
  findBookmarkRowById,
  insertAnnotation,
  insertAnnotationHistory,
  insertBookmark,
  softDeleteAnnotation,
  softDeleteBookmark,
  updateAnnotationRow,
  updateBookmarkRowById,
  upsertProgress,
} from '../reading/repo';
import { appendChange, lockUserChanges, upsertUserSettings } from './repo';
import {
  annotationChangePayload,
  bookmarkChangePayload,
  progressChangePayload,
  settingsChangePayload,
} from './service';

/** Outcome of one pushed change. */
export interface ApplyResult {
  status: 'applied' | 'skipped' | 'rejected';
  change?: SyncChangeEnvelope;
  reason?: SyncRejectReason;
}

/**
 * Distrusts client clocks that run far ahead: the receive time becomes the
 * change time instead, so one bad clock cannot pin an entity forever.
 */
export function effectiveClientTime(
  clientUpdatedAt: Date,
  now: Date,
): { time: Date; clockSkew: boolean } {
  if (clientUpdatedAt.getTime() > now.getTime() + SYNC_CLOCK_SKEW_MS) {
    return { time: now, clockSkew: true };
  }
  return { time: clientUpdatedAt, clockSkew: false };
}

/** Deterministic JSON for comparing payloads regardless of key insertion order. */
function stableJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (Array.isArray(value)) {
    return `[${value.map(stableJson).join(',')}]`;
  }
  const record = value as Record<string, unknown>;
  const keys = Object.keys(record).sort();
  return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`).join(',')}}`;
}

function samePayload(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

function rejected(reason: SyncRejectReason): ApplyResult {
  return { status: 'rejected', reason };
}

function skipped(): ApplyResult {
  return { status: 'skipped' };
}

function applied(change: SyncChangeEnvelope): ApplyResult {
  return { status: 'applied', change };
}

/** Client time of a stored entity; pre-sync rows fall back to their server time. */
function storedTimeOf(row: { clientUpdatedAt: Date | null; updatedAt: Date }): Date {
  return row.clientUpdatedAt ?? row.updatedAt;
}

/** The write fields a client pushes for an annotation. */
function annotationWritePayload(row: AnnotationRow): Record<string, unknown> {
  return {
    bookId: row.bookId,
    type: row.type,
    color: row.color,
    locator: row.locator,
    selectedText: row.selectedText,
    noteText: row.noteText,
    tags: row.tags,
  };
}

/** The write fields a client pushes for a bookmark. */
function bookmarkWritePayload(row: BookmarkRow): Record<string, unknown> {
  return {
    bookId: row.bookId,
    locator: row.locator,
    label: row.label,
  };
}

/**
 * Applies one pushed change under the last-writer-wins rules of the protocol.
 * A change whose client time matches the stored one is applied only when its
 * canonical write payload differs, which makes replayed batches no-ops.
 */
export async function applyChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
): Promise<ApplyResult> {
  const now = deps.clock.now();
  const { time } = effectiveClientTime(new Date(incoming.clientUpdatedAt), now);

  switch (incoming.entityType) {
    case 'reading_progress':
      return applyProgressChange(deps, actor, incoming, time, now);
    case 'annotation':
      return applyAnnotationChange(deps, actor, incoming, time, now);
    case 'bookmark':
      return applyBookmarkChange(deps, actor, incoming, time, now);
    case 'reader_settings':
      return applySettingsChange(deps, actor, incoming, time, now);
    default:
      return rejected('unknown_entity');
  }
}

async function applyProgressChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  clientTime: Date,
  now: Date,
): Promise<ApplyResult> {
  if (incoming.op !== 'upsert') {
    return rejected('unsupported_op');
  }

  const parsed = syncProgressPayloadSchema.safeParse(incoming.payload);
  if (!parsed.success) {
    return rejected('invalid_payload');
  }
  const { bookId, locator } = parsed.data;
  if (incoming.entityId !== bookId) {
    return rejected('invalid_payload');
  }

  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    return rejected('unknown_entity');
  }
  try {
    assertLocatorKind(book, locator);
  } catch (error) {
    if (error instanceof AppError) {
      return rejected('invalid_payload');
    }
    throw error;
  }

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const [stored] = await tx
      .select()
      .from(readingProgress)
      .where(and(eq(readingProgress.userId, actor.id), eq(readingProgress.bookId, bookId)))
      .limit(1)
      .for('update');

    if (stored) {
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(
          { bookId, locator },
          { bookId: stored.bookId, locator: stored.locator },
        )
      ) {
        return skipped();
      }
    }

    const row = await upsertProgress(tx, {
      userId: actor.id,
      bookId,
      locator,
      percent: locator.percent,
      deviceId: actor.deviceId ?? null,
      updatedAt: now,
      clientUpdatedAt: clientTime,
    });
    const change = await appendChange(tx, {
      userId: actor.id,
      entityType: 'reading_progress',
      entityId: bookId,
      op: 'upsert',
      payload: progressChangePayload(toProgressDto(row), clientTime),
      clientUpdatedAt: clientTime,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return applied(change);
  });
}

async function applyAnnotationChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  clientTime: Date,
  now: Date,
): Promise<ApplyResult> {
  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findAnnotationRowById(tx, incoming.entityId);

    if (incoming.op === 'delete') {
      if (!stored) {
        return skipped();
      }
      if (stored.userId !== actor.id) {
        return rejected('not_allowed');
      }
      if (stored.deletedAt !== null) {
        return skipped();
      }
      if (clientTime.getTime() < storedTimeOf(stored).getTime()) {
        return skipped();
      }

      const deleted = await softDeleteAnnotation(
        tx,
        stored.id,
        stored.bookId,
        actor.id,
        now,
        clientTime,
      );
      if (!deleted) {
        return skipped();
      }
      const change = await appendChange(tx, {
        userId: actor.id,
        entityType: 'annotation',
        entityId: stored.id,
        op: 'delete',
        payload: annotationChangePayload(toAnnotationDto(deleted), clientTime),
        clientUpdatedAt: clientTime,
        serverUpdatedAt: now,
        deviceId: actor.deviceId ?? null,
      });
      return applied(change);
    }

    const parsed = syncAnnotationPayloadSchema.safeParse(incoming.payload);
    if (!parsed.success) {
      return rejected('invalid_payload');
    }
    const write = {
      bookId: parsed.data.bookId,
      type: parsed.data.type,
      color: parsed.data.color,
      locator: parsed.data.locator,
      selectedText: parsed.data.selectedText,
      noteText: parsed.data.noteText,
      tags: normalizeTags(parsed.data.tags),
    };

    if (stored && stored.userId !== actor.id) {
      return rejected('not_allowed');
    }
    if (stored) {
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(write, annotationWritePayload(stored))
      ) {
        return skipped();
      }
    }

    let row: AnnotationRow;
    if (!stored) {
      row = await insertAnnotation(tx, {
        id: incoming.entityId,
        userId: actor.id,
        bookId: write.bookId,
        type: write.type,
        color: write.color,
        locator: write.locator,
        selectedText: write.selectedText,
        noteText: write.noteText,
        tags: write.tags,
        now,
        clientUpdatedAt: clientTime,
      });
    } else {
      if (
        write.noteText !== stored.noteText &&
        stored.noteText !== null &&
        stored.noteText.trim() !== ''
      ) {
        await insertAnnotationHistory(tx, {
          annotationId: stored.id,
          noteText: stored.noteText,
          editedAt: now,
          deviceId: actor.deviceId ?? null,
        });
      }
      row = await updateAnnotationRow(tx, stored.id, {
        color: write.color,
        noteText: write.noteText,
        tags: write.tags,
        revision: stored.revision + 1,
        now,
        clientUpdatedAt: clientTime,
        deletedAt: null,
      });
    }

    const change = await appendChange(tx, {
      userId: actor.id,
      entityType: 'annotation',
      entityId: row.id,
      op: 'upsert',
      payload: annotationChangePayload(toAnnotationDto(row), clientTime),
      clientUpdatedAt: clientTime,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return applied(change);
  });
}

async function applyBookmarkChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  clientTime: Date,
  now: Date,
): Promise<ApplyResult> {
  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findBookmarkRowById(tx, incoming.entityId);

    if (incoming.op === 'delete') {
      if (!stored) {
        return skipped();
      }
      if (stored.userId !== actor.id) {
        return rejected('not_allowed');
      }
      if (stored.deletedAt !== null) {
        return skipped();
      }
      if (clientTime.getTime() < storedTimeOf(stored).getTime()) {
        return skipped();
      }

      const deleted = await softDeleteBookmark(
        tx,
        stored.id,
        stored.bookId,
        actor.id,
        now,
        clientTime,
      );
      if (!deleted) {
        return skipped();
      }
      const change = await appendChange(tx, {
        userId: actor.id,
        entityType: 'bookmark',
        entityId: stored.id,
        op: 'delete',
        payload: bookmarkChangePayload(toBookmarkDto(deleted), clientTime),
        clientUpdatedAt: clientTime,
        serverUpdatedAt: now,
        deviceId: actor.deviceId ?? null,
      });
      return applied(change);
    }

    const parsed = syncBookmarkPayloadSchema.safeParse(incoming.payload);
    if (!parsed.success) {
      return rejected('invalid_payload');
    }
    const label = parsed.data.label === null || parsed.data.label === '' ? null : parsed.data.label;
    const write = {
      bookId: parsed.data.bookId,
      locator: parsed.data.locator,
      label,
    };

    if (stored && stored.userId !== actor.id) {
      return rejected('not_allowed');
    }
    if (stored) {
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(write, bookmarkWritePayload(stored))
      ) {
        return skipped();
      }
    }

    let row: BookmarkRow;
    if (!stored) {
      row = await insertBookmark(tx, {
        id: incoming.entityId,
        userId: actor.id,
        bookId: write.bookId,
        locator: write.locator,
        label: write.label,
        now,
        clientUpdatedAt: clientTime,
      });
    } else {
      row = await updateBookmarkRowById(tx, stored.id, {
        label: write.label,
        updatedAt: now,
        clientUpdatedAt: clientTime,
        deletedAt: null,
      });
    }

    const change = await appendChange(tx, {
      userId: actor.id,
      entityType: 'bookmark',
      entityId: row.id,
      op: 'upsert',
      payload: bookmarkChangePayload(toBookmarkDto(row), clientTime),
      clientUpdatedAt: clientTime,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return applied(change);
  });
}

async function applySettingsChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  clientTime: Date,
  now: Date,
): Promise<ApplyResult> {
  if (incoming.op !== 'upsert') {
    return rejected('unsupported_op');
  }

  const parsed = syncSettingsPayloadSchema.safeParse(incoming.payload);
  if (!parsed.success) {
    return rejected('invalid_payload');
  }
  if (incoming.entityId !== actor.id) {
    return rejected('invalid_payload');
  }

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const [stored] = await tx
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, actor.id))
      .limit(1)
      .for('update');

    if (stored) {
      if (clientTime.getTime() < stored.clientUpdatedAt.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === stored.clientUpdatedAt.getTime() &&
        samePayload({ settings: parsed.data.settings }, { settings: stored.payload })
      ) {
        return skipped();
      }
    }

    await upsertUserSettings(tx, {
      userId: actor.id,
      payload: parsed.data.settings,
      clientUpdatedAt: clientTime,
      updatedAt: now,
    });
    const change = await appendChange(tx, {
      userId: actor.id,
      entityType: 'reader_settings',
      entityId: actor.id,
      op: 'upsert',
      payload: settingsChangePayload(parsed.data.settings, clientTime, now),
      clientUpdatedAt: clientTime,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return applied(change);
  });
}
