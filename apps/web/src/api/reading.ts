import type { Locator, ReaderKind, ReadingProgressDto } from '@bookr/shared';
import { apiFetch } from './client';

/** Signed storage URL returned by `GET /api/books/:id/file`. */
export interface ReaderFileInfo {
  url: string;
  format: ReaderKind;
  expiresIn: number;
}

/** Signs the object the reader should open. */
export function fetchReaderFile(bookId: string): Promise<ReaderFileInfo> {
  return apiFetch<ReaderFileInfo>(`/api/books/${bookId}/file`);
}

/** Returns the caller's latest position, or null when the book is unread. */
export async function fetchProgress(bookId: string): Promise<ReadingProgressDto | null> {
  const result = await apiFetch<{ progress: ReadingProgressDto | null }>(
    `/api/books/${bookId}/progress`,
  );
  return result.progress ?? null;
}

/** Stores the caller's latest position for the book. */
export async function saveProgress(
  bookId: string,
  locator: Locator,
): Promise<ReadingProgressDto> {
  const result = await apiFetch<{ progress: ReadingProgressDto }>(
    `/api/books/${bookId}/progress`,
    {
      method: 'PUT',
      body: JSON.stringify({ locator }),
    },
  );
  return result.progress;
}
