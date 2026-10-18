import type {
  AnnotationColor,
  AnnotationDto,
  AnnotationMutationResult,
  BookmarkDto,
  Locator,
  ReaderKind,
  ReadingProgressDto,
} from '@bookr/shared';
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

/** Query keys shared by the reader page and its mutations. */
export function annotationsQueryKey(bookId: string) {
  return ['annotations', bookId] as const;
}

export function bookmarksQueryKey(bookId: string) {
  return ['bookmarks', bookId] as const;
}

/** Body of `POST /api/books/:id/annotations`. */
export interface CreateAnnotationInput {
  type: 'highlight' | 'note';
  color: AnnotationColor;
  locator: Locator;
  selectedText: string;
  noteText?: string | null;
  tags?: string[];
}

/** Body of `PATCH /api/books/:id/annotations/:annotationId`. */
export interface UpdateAnnotationInput {
  /** Optimistic-lock version the client last saw. */
  revision: number;
  color?: AnnotationColor;
  noteText?: string | null;
  tags?: string[];
}

/** Body of `POST /api/books/:id/bookmarks`. */
export interface CreateBookmarkInput {
  locator: Locator;
  label?: string | null;
}

/** Body of `PATCH /api/books/:id/bookmarks/:bookmarkId`. */
export interface UpdateBookmarkInput {
  label: string | null;
}

/** Lists the caller's live annotations on a book. */
export async function fetchAnnotations(bookId: string): Promise<AnnotationDto[]> {
  const result = await apiFetch<{ items: AnnotationDto[] }>(
    `/api/books/${bookId}/annotations`,
  );
  return result.items ?? [];
}

/** Creates a highlight or note owned by the caller. */
export async function createAnnotation(
  bookId: string,
  input: CreateAnnotationInput,
): Promise<AnnotationDto> {
  const result = await apiFetch<{ annotation: AnnotationDto }>(
    `/api/books/${bookId}/annotations`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.annotation;
}

/**
 * Rewrites an annotation. A stale `revision` is not an error: the server still
 * applies the edit and reports `conflict: true` with the stored annotation.
 */
export function updateAnnotation(
  bookId: string,
  annotationId: string,
  patch: UpdateAnnotationInput,
): Promise<AnnotationMutationResult> {
  return apiFetch<AnnotationMutationResult>(
    `/api/books/${bookId}/annotations/${annotationId}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
}

/** Soft-deletes one of the caller's annotations. */
export async function deleteAnnotation(bookId: string, annotationId: string): Promise<void> {
  await apiFetch<void>(`/api/books/${bookId}/annotations/${annotationId}`, {
    method: 'DELETE',
  });
}

/** Lists the caller's live bookmarks on a book. */
export async function fetchBookmarks(bookId: string): Promise<BookmarkDto[]> {
  const result = await apiFetch<{ items: BookmarkDto[] }>(
    `/api/books/${bookId}/bookmarks`,
  );
  return result.items ?? [];
}

/** Creates a named reading position. */
export async function createBookmark(
  bookId: string,
  input: CreateBookmarkInput,
): Promise<BookmarkDto> {
  const result = await apiFetch<{ bookmark: BookmarkDto }>(
    `/api/books/${bookId}/bookmarks`,
    { method: 'POST', body: JSON.stringify(input) },
  );
  return result.bookmark;
}

/** Renames a bookmark; an empty label clears it. */
export async function updateBookmark(
  bookId: string,
  bookmarkId: string,
  patch: UpdateBookmarkInput,
): Promise<BookmarkDto> {
  const result = await apiFetch<{ bookmark: BookmarkDto }>(
    `/api/books/${bookId}/bookmarks/${bookmarkId}`,
    { method: 'PATCH', body: JSON.stringify(patch) },
  );
  return result.bookmark;
}

/** Soft-deletes one of the caller's bookmarks. */
export async function deleteBookmark(bookId: string, bookmarkId: string): Promise<void> {
  await apiFetch<void>(`/api/books/${bookId}/bookmarks/${bookmarkId}`, {
    method: 'DELETE',
  });
}
