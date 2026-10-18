import {
  ERROR_CODES,
  readerKindForFormat,
  type Locator,
  type ReadingProgressDto,
} from '@bookr/shared';
import type { AppDeps } from '../app';
import { findBookById } from '../books/repo';
import type { BookRow } from '../db/schema';
import { AppError } from '../errors';
import { toProgressDto } from './dto';
import { findProgressRow, upsertProgress } from './repo';

/** The authenticated caller, as needed to attribute a progress write. */
export interface ReadingActor {
  id: string;
  deviceId?: string;
}

/** Loads a book that has not been trashed; missing and deleted rows are 404. */
export async function requireLiveBook(deps: AppDeps, bookId: string): Promise<BookRow> {
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return book;
}

/**
 * Rejects a locator produced by a different reading engine. PDF books only
 * accept `pdf` locators and every other format renders through the EPUB
 * reader, which only accepts `epub` locators.
 */
export function assertLocatorKind(book: BookRow, locator: Locator): void {
  const expectedKind = readerKindForFormat(book.format);
  if (locator.kind !== expectedKind) {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, { expectedKind });
  }
}

/** Returns the caller's latest position for a live book, or null when unread. */
export async function getProgress(
  deps: AppDeps,
  userId: string,
  bookId: string,
): Promise<ReadingProgressDto | null> {
  await requireLiveBook(deps, bookId);
  const row = await findProgressRow(deps.db, userId, bookId);
  return row ? toProgressDto(row) : null;
}

/**
 * Stores the caller's latest position. Percent is derived from the locator so
 * the two can never disagree, and the issuing device is recorded for later
 * sync diagnostics.
 */
export async function saveProgress(
  deps: AppDeps,
  actor: ReadingActor,
  bookId: string,
  locator: Locator,
): Promise<ReadingProgressDto> {
  const book = await requireLiveBook(deps, bookId);
  assertLocatorKind(book, locator);

  const row = await upsertProgress(deps.db, {
    userId: actor.id,
    bookId,
    locator,
    percent: locator.percent,
    deviceId: actor.deviceId ?? null,
    updatedAt: deps.clock.now(),
  });
  return toProgressDto(row);
}
