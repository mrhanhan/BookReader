import {
  ERROR_CODES,
  readerKindForFormat,
  type Locator,
} from '@bookr/shared';
import type { AppDeps } from '../app';
import { findBookById } from '../books/repo';
import type { BookRow } from '../db/schema';
import { AppError } from '../errors';

/** The authenticated caller, as needed to attribute a reading write. */
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
 * Rejects a locator produced by a different reading engine. A PDF can be read
 * as the original document or as its reflowed pack, so it accepts both locator
 * kinds; every other format renders through the EPUB reader, which only
 * accepts `epub` locators.
 */
export function assertLocatorKind(book: BookRow, locator: Locator): void {
  const expectedKind = readerKindForFormat(book.format);
  const acceptedKinds: readonly string[] =
    expectedKind === 'pdf' ? ['pdf', 'reflow'] : [expectedKind];
  if (!acceptedKinds.includes(locator.kind)) {
    throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, { expectedKind });
  }
}
