import {
  NOTE_EXPORT_MAX_ITEMS,
  type NoteDto,
  type NoteFilters,
  type NoteListQuery,
  type NoteListResponse,
  type NoteTagCount,
} from '@bookr/shared';
import type { AppDeps } from '../app';
import { buildNotesMarkdown, notesExportFilename } from './export';
import {
  findLiveBookTitle,
  listNotePage,
  listNoteTagCounts,
  listNotesForExport,
  loadUserTimezone,
  type NoteQueryRow,
} from './repo';

/** Maps a joined query row to the API shape. */
export function toNoteDto(row: NoteQueryRow): NoteDto {
  return {
    id: row.annotation.id,
    book: row.book,
    type: row.annotation.type,
    color: row.annotation.color,
    locator: row.annotation.locator,
    selectedText: row.annotation.selectedText,
    noteText: row.annotation.noteText,
    tags: row.annotation.tags ?? [],
    revision: row.annotation.revision,
    createdAt: row.annotation.createdAt.toISOString(),
    updatedAt: row.annotation.updatedAt.toISOString(),
  };
}

/** One page of the caller's notes library. */
export async function listNotes(
  deps: AppDeps,
  userId: string,
  query: NoteListQuery,
): Promise<NoteListResponse> {
  const timezone = await loadUserTimezone(deps.db, userId);
  const { page, pageSize, ...filters } = query;
  const { rows, total } = await listNotePage(deps.db, {
    userId,
    timezone,
    filters,
    page,
    pageSize,
  });
  return { items: rows.map(toNoteDto), total, page, pageSize };
}

/** Distinct tags across the caller's visible notes, most used first. */
export async function listNoteTags(deps: AppDeps, userId: string): Promise<NoteTagCount[]> {
  return listNoteTagCounts(deps.db, userId);
}

/** Builds the Markdown export for the filtered note set. */
export async function exportNotes(
  deps: AppDeps,
  userId: string,
  filters: NoteFilters,
): Promise<{ markdown: string; filename: string; total: number; truncated: boolean }> {
  const timezone = await loadUserTimezone(deps.db, userId);
  const { rows, total } = await listNotesForExport(deps.db, {
    userId,
    timezone,
    filters,
    limit: NOTE_EXPORT_MAX_ITEMS,
  });
  const truncated = total > NOTE_EXPORT_MAX_ITEMS;
  const generatedAt = deps.clock.now();
  const bookTitle = filters.bookId ? await findLiveBookTitle(deps.db, filters.bookId) : null;
  const markdown = buildNotesMarkdown({ notes: rows, total, truncated, generatedAt, timezone });
  const filename = notesExportFilename({ bookTitle, generatedAt, timezone });
  return { markdown, filename, total, truncated };
}
