import {
  SYNC_CLOCK_SKEW_MS,
  normalizeTags,
  syncAnnotationPayloadSchema,
  syncBookmarkPayloadSchema,
  syncProgressPayloadSchema,
  syncReadingSessionPayloadSchema,
  syncSettingsPayloadSchema,
  type Locator,
  type SyncChangeEnvelope,
  type SyncPushChange,
  type SyncRejectReason,
} from '@bookr/shared';
import { and, eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { findBookById } from '../books/repo';
import {
  readingProgress,
  userSettings,
  type AnnotationRow,
  type BookmarkRow,
  type ReadingSessionRow,
} from '../db/schema';
import { AppError } from '../errors';
import { toAnnotationDto, toBookmarkDto, toProgressDto } from '../reading/dto';
import { assertLocatorKind, type ReadingActor } from '../reading/guards';
import { recomputeDailyStats, sessionLocalDates } from '../stats/aggregate';
import {
  findReadingSession,
  readUserTimezone,
  upsertReadingSession,
} from '../stats/repo';
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
  sessionChangePayload,
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

/** Deterministic JSON. Payloads arrive through JSON, so cycles are a bug, not input. */
function stableJson(value: unknown, seen: Set<object> = new Set()): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value) ?? 'null';
  }
  if (seen.has(value)) {
    throw new Error('Cannot compare a cyclic payload');
  }
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${value.map((item) => stableJson(item, seen)).join(',')}]`;
    }
    const record = value as Record<string, unknown>;
    const keys = Object.keys(record).sort();
    return `{${keys.map((key) => `${JSON.stringify(key)}:${stableJson(record[key], seen)}`).join(',')}}`;
  } finally {
    seen.delete(value);
  }
}

function samePayload(left: unknown, right: unknown): boolean {
  return stableJson(left) === stableJson(right);
}

/** Parsed, normalized write fields plus the times they are applied at. */
interface ApplyContext {
  clientTime: Date;
  clockSkew: boolean;
  now: Date;
}

/**
 * Rejects changes whose book is missing or whose locator belongs to another
 * reading engine. Returns undefined when the change may proceed.
 */
async function invalidBookOrLocator(
  deps: AppDeps,
  bookId: string,
  locator: Locator,
): Promise<ApplyResult | undefined> {
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
  return undefined;
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

/** The write fields an annotation upsert actually stores. */
function annotationWritePayload(row: AnnotationRow): Record<string, unknown> {
  return {
    color: row.color,
    noteText: row.noteText,
    tags: row.tags,
  };
}

/** The write field a bookmark upsert actually stores. */
function bookmarkWritePayload(row: BookmarkRow): Record<string, unknown> {
  return {
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
  const effective = effectiveClientTime(new Date(incoming.clientUpdatedAt), now);
  const context: ApplyContext = {
    clientTime: effective.time,
    clockSkew: effective.clockSkew,
    now,
  };

  switch (incoming.entityType) {
    case 'reading_progress':
      return applyProgressChange(deps, actor, incoming, context);
    case 'annotation':
      return applyAnnotationChange(deps, actor, incoming, context);
    case 'bookmark':
      return applyBookmarkChange(deps, actor, incoming, context);
    case 'reader_settings':
      return applySettingsChange(deps, actor, incoming, context);
    case 'reading_session':
      return applyReadingSessionChange(deps, actor, incoming, context);
    default:
      return rejected('unknown_entity');
  }
}

async function applyProgressChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, clockSkew, now } = context;
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

  const invalid = await invalidBookOrLocator(deps, bookId, locator);
  if (invalid !== undefined) {
    return invalid;
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
      const write = { locator };
      // A clamped clock cannot order retries, so an identical payload wins.
      if (clockSkew && samePayload(write, { locator: stored.locator })) {
        return skipped();
      }
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(write, { locator: stored.locator })
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
  context: ApplyContext,
): Promise<ApplyResult> {
  if (incoming.op === 'delete') {
    return applyAnnotationDelete(deps, actor, incoming, context);
  }
  return applyAnnotationUpsert(deps, actor, incoming, context);
}

async function applyAnnotationUpsert(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, clockSkew, now } = context;
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
  const invalid = await invalidBookOrLocator(deps, write.bookId, write.locator);
  if (invalid !== undefined) {
    return invalid;
  }

  // Only these fields are written by an upsert; locator and selected text are
  // immutable for an existing annotation and must not defeat idempotency.
  const fields = {
    color: write.color,
    noteText: write.noteText,
    tags: write.tags,
  };

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findAnnotationRowById(tx, incoming.entityId);

    if (stored && stored.userId !== actor.id) {
      return rejected('not_allowed');
    }
    if (stored) {
      // A clamped clock cannot order retries, so an identical payload wins.
      if (clockSkew && samePayload(fields, annotationWritePayload(stored))) {
        return skipped();
      }
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        // The incoming edit loses the race, but its text is still user work.
        // Archive it before skipping so a late offline edit never vanishes.
        if (write.noteText !== null && write.noteText !== stored.noteText) {
          await insertAnnotationHistory(tx, {
            annotationId: stored.id,
            noteText: write.noteText,
            editedAt: now,
            deviceId: actor.deviceId ?? null,
          });
        }
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(fields, annotationWritePayload(stored))
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

async function applyAnnotationDelete(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, now } = context;

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findAnnotationRowById(tx, incoming.entityId);

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
  });
}

async function applyBookmarkChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  if (incoming.op === 'delete') {
    return applyBookmarkDelete(deps, actor, incoming, context);
  }
  return applyBookmarkUpsert(deps, actor, incoming, context);
}

async function applyBookmarkUpsert(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, clockSkew, now } = context;
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
  const invalid = await invalidBookOrLocator(deps, write.bookId, write.locator);
  if (invalid !== undefined) {
    return invalid;
  }

  // Only the label is written when a bookmark already exists.
  const fields = { label };

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findBookmarkRowById(tx, incoming.entityId);

    if (stored && stored.userId !== actor.id) {
      return rejected('not_allowed');
    }
    if (stored) {
      // A clamped clock cannot order retries, so an identical payload wins.
      if (clockSkew && samePayload(fields, bookmarkWritePayload(stored))) {
        return skipped();
      }
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(fields, bookmarkWritePayload(stored))
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

async function applyBookmarkDelete(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, now } = context;

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findBookmarkRowById(tx, incoming.entityId);

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
  });
}

async function applySettingsChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, clockSkew, now } = context;
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

  const write = { settings: parsed.data.settings };

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const [stored] = await tx
      .select()
      .from(userSettings)
      .where(eq(userSettings.userId, actor.id))
      .limit(1)
      .for('update');

    if (stored) {
      // A clamped clock cannot order retries, so an identical payload wins.
      if (clockSkew && samePayload(write, { settings: stored.payload })) {
        return skipped();
      }
      if (clientTime.getTime() < stored.clientUpdatedAt.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === stored.clientUpdatedAt.getTime() &&
        samePayload(write, { settings: stored.payload })
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

/** Write fields compared for idempotency; timestamps are compared separately. */
function sessionWritePayload(row: ReadingSessionRow): Record<string, unknown> {
  return {
    bookId: row.bookId,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt.toISOString(),
    activeSeconds: row.activeSeconds,
    pagesRead: row.pagesRead,
  };
}

/**
 * Applies one session heartbeat. The client owns the id and sends cumulative
 * values, so the newest heartbeat wins by client time and a shorter value is
 * always refused: a late or replayed packet must never erase reading time.
 */
async function applyReadingSessionChange(
  deps: AppDeps,
  actor: ReadingActor,
  incoming: SyncPushChange,
  context: ApplyContext,
): Promise<ApplyResult> {
  const { clientTime, clockSkew, now } = context;
  if (incoming.op !== 'upsert') {
    return rejected('unsupported_op');
  }

  const parsed = syncReadingSessionPayloadSchema.safeParse(incoming.payload);
  if (!parsed.success) {
    return rejected('invalid_payload');
  }

  const book = await findBookById(deps.db, parsed.data.bookId, { includeDeleted: false });
  if (!book) {
    return rejected('unknown_entity');
  }

  const startedAt = new Date(parsed.data.startedAt);
  const endedAt = new Date(parsed.data.endedAt);
  const write = {
    bookId: parsed.data.bookId,
    startedAt: startedAt.toISOString(),
    endedAt: endedAt.toISOString(),
    activeSeconds: parsed.data.activeSeconds,
    pagesRead: parsed.data.pagesRead,
  };

  return deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const stored = await findReadingSession(tx, incoming.entityId);

    if (stored && stored.userId !== actor.id) {
      return rejected('not_allowed');
    }

    if (stored) {
      // A clamped clock cannot order retries, so an identical payload wins.
      if (clockSkew && samePayload(write, sessionWritePayload(stored))) {
        return skipped();
      }
      const storedTime = storedTimeOf(stored);
      if (clientTime.getTime() < storedTime.getTime()) {
        return skipped();
      }
      if (
        clientTime.getTime() === storedTime.getTime() &&
        samePayload(write, sessionWritePayload(stored))
      ) {
        return skipped();
      }
      // Heartbeats are cumulative; accepting a smaller value would delete
      // reading time that is already recorded.
      if (parsed.data.activeSeconds < stored.activeSeconds) {
        return skipped();
      }
    }

    const row = await upsertReadingSession(tx, {
      id: incoming.entityId,
      userId: actor.id,
      bookId: parsed.data.bookId,
      deviceId: actor.deviceId ?? null,
      startedAt,
      endedAt,
      activeSeconds: parsed.data.activeSeconds,
      pagesRead: parsed.data.pagesRead,
      clientUpdatedAt: clientTime,
      updatedAt: now,
    });

    const timezone = await readUserTimezone(tx, actor.id);
    const dates = new Set(sessionLocalDates(startedAt, endedAt, timezone));
    if (stored) {
      for (const date of sessionLocalDates(stored.startedAt, stored.endedAt, timezone)) {
        dates.add(date);
      }
    }
    await recomputeDailyStats(tx, actor.id, timezone, [...dates], now);

    const change = await appendChange(tx, {
      userId: actor.id,
      entityType: 'reading_session',
      entityId: incoming.entityId,
      op: 'upsert',
      payload: sessionChangePayload(row, clientTime),
      clientUpdatedAt: clientTime,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return applied(change);
  });
}
