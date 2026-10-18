import {
  ERROR_CODES,
  readerKindForFormat,
  type BookFormat,
  type ReaderKind,
} from '@bookr/shared';
import type { AppDeps } from '../app';
import { AppError } from '../errors';
import { findBookById } from './repo';

/** Signed reader file URLs live for one hour. */
export const READER_FILE_URL_EXPIRES_SECONDS = 3600;

/** The storage URL and reader format for one book. */
export interface ReaderFile {
  url: string;
  format: ReaderKind;
  expiresIn: number;
}

/** MOBI and AZW3 are read through a converted EPUB, not the original file. */
function requiresConvertedEpub(format: BookFormat): boolean {
  return format === 'mobi' || format === 'azw3';
}

/**
 * Signs the object a reader should open. The shelf is shared, so any active
 * member may read any live book; only the book's presence and object key are
 * checked here, and the bytes themselves are fetched straight from storage.
 */
export async function getReaderFile(deps: AppDeps, bookId: string): Promise<ReaderFile> {
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  const converted = requiresConvertedEpub(book.format);
  // The conversion status cannot be trusted as an existence check: once the
  // EPUB object is written it is readable, even if the row still says 'failed'.
  const key = converted ? book.epubKey : book.fileKey;

  if (key === null) {
    if (converted) {
      throw new AppError(409, ERROR_CODES.BOOK_NOT_READY, {
        conversionStatus: book.conversionStatus,
      });
    }
    throw new AppError(404, ERROR_CODES.FILE_MISSING);
  }

  const url = await deps.storage.presignGet(key, READER_FILE_URL_EXPIRES_SECONDS);
  return {
    url,
    format: readerKindForFormat(book.format),
    expiresIn: READER_FILE_URL_EXPIRES_SECONDS,
  };
}
