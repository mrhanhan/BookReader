import {
  ERROR_CODES,
  createBookmarkSchema,
  updateBookmarkSchema,
  type BookmarkDto,
} from '@bookr/shared';
import type { z } from 'zod';
import type { AppDeps } from '../app';
import { AppError } from '../errors';
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

  const row = await insertBookmark(deps.db, {
    userId: actor.id,
    bookId,
    locator: input.locator,
    label: input.label,
    now: deps.clock.now(),
  });
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
  const row = await updateBookmarkRow(
    deps.db,
    bookmarkId,
    bookId,
    actor.id,
    input.label,
    deps.clock.now(),
  );
  if (!row) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return toBookmarkDto(row);
}

/** Soft-deletes the caller's bookmark; any other target is a 404. */
export async function deleteBookmark(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  bookmarkId: string,
): Promise<void> {
  await requireLiveBook(deps, bookId);
  const deleted = await softDeleteBookmark(
    deps.db,
    bookmarkId,
    bookId,
    actor.id,
    deps.clock.now(),
  );
  if (!deleted) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
}
