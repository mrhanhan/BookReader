import type { BookDto, CategoryDto } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { users, type BookRow } from '../db/schema';

/** Cover URLs stay valid for one hour; clients refetch the book to renew them. */
const COVER_URL_EXPIRES_SECONDS = 3600;

/**
 * Maps a book row to the API shape, signing the cover key when present.
 * Shared by the upload pipeline and the bookshelf routes. Callers that list
 * many books pass the preloaded uploader name to avoid a query per book.
 */
export async function toBookDto(
  deps: AppDeps,
  book: BookRow,
  categories: CategoryDto[],
  uploaderDisplayName?: string,
): Promise<BookDto> {
  let displayName = uploaderDisplayName;
  if (displayName === undefined) {
    const [uploader] = await deps.db
      .select({ displayName: users.displayName })
      .from(users)
      .where(eq(users.id, book.uploadedBy))
      .limit(1);

    if (!uploader) {
      throw new Error(`Uploader ${book.uploadedBy} does not exist for book ${book.id}`);
    }
    displayName = uploader.displayName;
  }

  return {
    id: book.id,
    title: book.title,
    author: book.author,
    description: book.description,
    format: book.format,
    size: book.size,
    coverUrl: book.coverKey
      ? await deps.storage.presignGet(book.coverKey, COVER_URL_EXPIRES_SECONDS)
      : null,
    status: book.status,
    progressPercent: 0,
    categories,
    uploadedBy: { id: book.uploadedBy, displayName },
    conversionStatus: book.conversionStatus,
    conversionError: book.conversionError,
    createdAt: book.createdAt.toISOString(),
    updatedAt: book.updatedAt.toISOString(),
    deletedAt: book.deletedAt ? book.deletedAt.toISOString() : null,
  };
}
