import type { ReadingProgressDto } from '@bookr/shared';
import type { ReadingProgressRow } from '../db/schema';

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
