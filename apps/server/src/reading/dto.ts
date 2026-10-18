import type { AnnotationDto, BookmarkDto, ReadingProgressDto } from '@bookr/shared';
import type { AnnotationRow, BookmarkRow, ReadingProgressRow } from '../db/schema';

/** Maps a progress row to the API shape; `deviceId` stays private. */
export function toProgressDto(row: ReadingProgressRow): ReadingProgressDto {
  return {
    bookId: row.bookId,
    locator: row.locator,
    percent: row.percent,
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Progress summary embedded in shelf DTOs; undefined when the viewer has not read. */
export function toBookProgress(
  row: ReadingProgressRow | undefined,
): { percent: number } | undefined {
  return row ? { percent: row.percent } : undefined;
}

/** Maps an annotation row to the API shape, defaulting absent tags to an empty list. */
export function toAnnotationDto(row: AnnotationRow): AnnotationDto {
  return {
    id: row.id,
    bookId: row.bookId,
    type: row.type,
    color: row.color,
    locator: row.locator,
    selectedText: row.selectedText,
    noteText: row.noteText,
    tags: row.tags ?? [],
    revision: row.revision,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}

/** Maps a bookmark row to the API shape; a cleared label stays null. */
export function toBookmarkDto(row: BookmarkRow): BookmarkDto {
  return {
    id: row.id,
    bookId: row.bookId,
    locator: row.locator,
    label: row.label,
    createdAt: row.createdAt.toISOString(),
    updatedAt: row.updatedAt.toISOString(),
  };
}
