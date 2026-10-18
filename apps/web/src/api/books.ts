import type { BookDto, BookStatus, UpdateBookInput } from '@bookr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

export type BookSort = 'recent' | 'added' | 'title';

/** Filter state sent to `GET /api/books`. */
export interface BooksQuery {
  query?: string;
  format?: BookDto['format'];
  status?: BookStatus;
  categoryId?: string;
  sort?: BookSort;
  page?: number;
  pageSize?: number;
}

export interface BookListPage {
  items: BookDto[];
  total: number;
  page: number;
  pageSize: number;
}

export const TRASH_QUERY_KEY = ['trash'] as const;

/** Query-key prefix shared by every shelf page, so one invalidate refetches all. */
export const BOOKS_QUERY_KEY = ['books'] as const;

export function booksQueryKey(query: BooksQuery) {
  return [...BOOKS_QUERY_KEY, query] as const;
}

/** Serializes filters, omitting blank values so the server sees its defaults. */
export function buildBooksQueryString(query: BooksQuery): string {
  const params = new URLSearchParams();
  const search = query.query?.trim();
  if (search) params.set('query', search);
  if (query.format) params.set('format', query.format);
  if (query.status) params.set('status', query.status);
  if (query.categoryId) params.set('categoryId', query.categoryId);
  params.set('sort', query.sort ?? 'recent');
  params.set('page', String(query.page ?? 1));
  params.set('pageSize', String(query.pageSize ?? 24));
  return params.toString();
}

export function fetchBooks(query: BooksQuery): Promise<BookListPage> {
  return apiFetch<BookListPage>(`/api/books?${buildBooksQueryString(query)}`);
}

export function useBooks(query: BooksQuery) {
  return useQuery({
    queryKey: booksQueryKey(query),
    queryFn: () => fetchBooks(query),
  });
}

export function useBook(id: string | null) {
  return useQuery({
    queryKey: ['book', id],
    queryFn: async () => (await apiFetch<{ book: BookDto }>(`/api/books/${id}`)).book,
    enabled: Boolean(id),
  });
}

/** A shelf change must refresh the filtered pages, the single-book cache and trash. */
export function invalidateBookQueries(
  queryClient: QueryClient,
  bookId?: string,
): Promise<void> {
  const tasks: Promise<unknown>[] = [
    queryClient.invalidateQueries({ queryKey: BOOKS_QUERY_KEY }),
    queryClient.invalidateQueries({ queryKey: TRASH_QUERY_KEY }),
  ];
  if (bookId) {
    tasks.push(queryClient.invalidateQueries({ queryKey: ['book', bookId] }));
  }
  return Promise.all(tasks).then(() => undefined);
}

export function useUpdateBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async ({ id, patch }: { id: string; patch: UpdateBookInput }) =>
      (await apiFetch<{ book: BookDto }>(`/api/books/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      })).book,
    onSuccess: (book) => invalidateBookQueries(queryClient, book.id),
  });
}

export function useDeleteBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) => apiFetch<void>(`/api/books/${id}`, { method: 'DELETE' }),
    onSuccess: (_result, id) => invalidateBookQueries(queryClient, id),
  });
}

export function useRestoreBook() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: async (id: string) =>
      (await apiFetch<{ book: BookDto }>(`/api/books/${id}/restore`, { method: 'POST' })).book,
    onSuccess: (book) => invalidateBookQueries(queryClient, book.id),
  });
}

export function useTrash() {
  return useQuery({
    queryKey: TRASH_QUERY_KEY,
    queryFn: async () => (await apiFetch<{ items: BookDto[] }>('/api/trash')).items,
  });
}

/**
 * Uploads a replacement cover as multipart form data. `apiFetch` leaves the
 * Content-Type unset for FormData so the browser adds the boundary.
 */
export async function uploadCover(bookId: string, file: File): Promise<string> {
  const form = new FormData();
  form.append('cover', file);
  const result = await apiFetch<{ coverUrl: string }>(`/api/books/${bookId}/cover`, {
    method: 'POST',
    body: form,
  });
  return result.coverUrl;
}

export function useUploadCover() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, file }: { id: string; file: File }) => uploadCover(id, file),
    onSuccess: (_coverUrl, { id }) => invalidateBookQueries(queryClient, id),
  });
}

/** Queues another MOBI/AZW3 conversion attempt for a pending or failed book. */
export function useRetryConversion() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<{ queued: boolean }>(`/api/books/${id}/convert`, { method: 'POST' }),
    onSuccess: (_result, id) => invalidateBookQueries(queryClient, id),
  });
}
