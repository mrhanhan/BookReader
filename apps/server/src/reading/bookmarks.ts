import {
  ERROR_CODES,
  createBookmarkSchema,
  updateBookmarkSchema,
  type BookmarkDto,
} from '@bookr/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app';
import { AppError } from '../errors';
import { lockUserChanges } from '../sync/repo';
import { bookmarkChangePayload, recordChange } from '../sync/service';
import { toBookmarkDto } from './dto';
import { assertLocatorKind, requireLiveBook, type ReadingActor } from './guards';
import {
  insertBookmark,
  listBookmarkRows,
  softDeleteBookmark,
  updateBookmarkRow,
} from './repo';

type CreateBookmarkInput = z.infer<typeof createBookmarkSchema>;
type UpdateBookmarkInput = z.infer<typeof updateBookmarkSchema>;

/** Lists the caller's live bookmarks on a live book, newest first. */
export async function listBookmarks(
  deps: AppDeps,
  userId: string,
  bookId: string,
): Promise<BookmarkDto[]> {
  await requireLiveBook(deps, bookId);
  const rows = await listBookmarkRows(deps.db, userId, bookId);
  return rows.map(toBookmarkDto);
}

/** Creates a bookmark owned by the caller on a live book. */
export async function createBookmark(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  input: CreateBookmarkInput,
): Promise<BookmarkDto> {
  const book = await requireLiveBook(deps, bookId);
  assertLocatorKind(book, input.locator);
  const now = deps.clock.now();

  const { row, change } = await deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const inserted = await insertBookmark(tx, {
      userId: actor.id,
      bookId,
      locator: input.locator,
      label: input.label,
      now,
      clientUpdatedAt: now,
    });
    const dto = toBookmarkDto(inserted);
    const change = await recordChange(tx, {
      userId: actor.id,
      entityType: 'bookmark',
      entityId: inserted.id,
      op: 'upsert',
      payload: bookmarkChangePayload(dto, now),
      clientUpdatedAt: now,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return { row: inserted, change };
  });
  deps.syncHub.publish(actor.id, change);
  return toBookmarkDto(row);
}

/** Renames the caller's bookmark; any other target is a 404. */
export async function updateBookmark(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  bookmarkId: string,
  input: UpdateBookmarkInput,
): Promise<BookmarkDto> {
  await requireLiveBook(deps, bookId);
  const now = deps.clock.now();

  const { dto, change } = await deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const row = await updateBookmarkRow(tx, bookmarkId, bookId, actor.id, input.label, now, now);
    if (!row) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    const dto = toBookmarkDto(row);
    const change = await recordChange(tx, {
      userId: actor.id,
      entityType: 'bookmark',
      entityId: bookmarkId,
      op: 'upsert',
      payload: bookmarkChangePayload(dto, now),
      clientUpdatedAt: now,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
    return { dto, change };
  });
  deps.syncHub.publish(actor.id, change);
  return dto;
}

/** Soft-deletes the caller's bookmark; any other target is a 404. */
export async function deleteBookmark(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  bookmarkId: string,
): Promise<void> {
  await requireLiveBook(deps, bookId);
  const now = deps.clock.now();

  const change = await deps.db.transaction(async (tx) => {
    await lockUserChanges(tx, actor.id);
    const deleted = await softDeleteBookmark(tx, bookmarkId, bookId, actor.id, now);
    if (!deleted) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    return recordChange(tx, {
      userId: actor.id,
      entityType: 'bookmark',
      entityId: bookmarkId,
      op: 'delete',
      payload: bookmarkChangePayload(toBookmarkDto(deleted), now),
      clientUpdatedAt: now,
      serverUpdatedAt: now,
      deviceId: actor.deviceId ?? null,
    });
  });
  deps.syncHub.publish(actor.id, change);
}
