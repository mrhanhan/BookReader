import type { AnnotationColor, NoteFilters } from '@bookr/shared';
import { useInfiniteQuery, useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  fetchNoteTags,
  fetchNotes,
  notesQueryKey,
  NOTES_QUERY_KEY,
} from '../../api/notes';
import {
  annotationsQueryKey,
  deleteAnnotation,
  updateAnnotation,
} from '../../api/reading';

/** One page of notes, newest first, keyed by the active filters. */
export function useNotesList(filters: NoteFilters) {
  return useInfiniteQuery({
    queryKey: [...notesQueryKey(filters), 'infinite'] as const,
    queryFn: ({ pageParam }) => fetchNotes({ ...filters, page: pageParam }),
    initialPageParam: 1,
    getNextPageParam: (last) =>
      last.page * last.pageSize < last.total ? last.page + 1 : undefined,
  });
}

/** Distinct tags across the caller's notes, most used first. */
export function useNoteTags() {
  return useQuery({
    queryKey: [NOTES_QUERY_KEY, 'tags'] as const,
    queryFn: fetchNoteTags,
  });
}

/** Fields the edit dialog may rewrite on one note. */
export interface UpdateNoteInput {
  bookId: string;
  noteId: string;
  revision: number;
  noteText: string | null;
  tags: string[];
  color: AnnotationColor;
}

/**
 * Edits a note through the REST annotation endpoint. Besides the notes list,
 * the book's annotation cache is invalidated so the reader refreshes on its
 * next sync; the local Dexie copy is deliberately left to the sync engine.
 */
export function useUpdateNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: UpdateNoteInput) =>
      updateAnnotation(input.bookId, input.noteId, {
        revision: input.revision,
        noteText: input.noteText,
        tags: input.tags,
        color: input.color,
      }),
    onSuccess: (_result, input) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [NOTES_QUERY_KEY] }),
        queryClient.invalidateQueries({ queryKey: annotationsQueryKey(input.bookId) }),
      ]).then(() => undefined),
  });
}

export interface DeleteNoteInput {
  bookId: string;
  noteId: string;
}

/** Deletes one note through the REST annotation endpoint. */
export function useDeleteNote() {
  const queryClient = useQueryClient();

  return useMutation({
    mutationFn: (input: DeleteNoteInput) =>
      deleteAnnotation(input.bookId, input.noteId),
    onSuccess: (_result, input) =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: [NOTES_QUERY_KEY] }),
        queryClient.invalidateQueries({ queryKey: annotationsQueryKey(input.bookId) }),
      ]).then(() => undefined),
  });
}

export { useOnlineStatus } from '../../lib/useOnlineStatus';
