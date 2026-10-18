import { and, eq, inArray } from 'drizzle-orm';
import type { Database } from '../db/client';
import { readingProgress, type ReadingProgressRow } from '../db/schema';

/** Fields written by a progress upsert. */
export interface UpsertProgressInput {
  userId: string;
  bookId: string;
  locator: ReadingProgressRow['locator'];
  percent: number;
  deviceId: string | null;
  updatedAt: Date;
}

/** Loads one user's progress for a book, or undefined when unread. */
export async function findProgressRow(
  db: Database,
  userId: string,
  bookId: string,
): Promise<ReadingProgressRow | undefined> {
  const [row] = await db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), eq(readingProgress.bookId, bookId)))
    .limit(1);
  return row;
}

/**
 * Loads one user's progress for many books in a single query, keyed by book
 * id. The shelf uses this to avoid a progress query per item.
 */
export async function findProgressForBooks(
  db: Database,
  userId: string,
  bookIds: string[],
): Promise<Map<string, ReadingProgressRow>> {
  if (bookIds.length === 0) {
    return new Map();
  }

  const rows = await db
    .select()
    .from(readingProgress)
    .where(and(eq(readingProgress.userId, userId), inArray(readingProgress.bookId, bookIds)));

  return new Map(rows.map((row) => [row.bookId, row]));
}

/**
 * Writes the latest position for one user and book. The composite primary key
 * makes this an upsert, so re-reading a book replaces its single row.
 */
export async function upsertProgress(
  db: Database,
  input: UpsertProgressInput,
): Promise<ReadingProgressRow> {
  const [row] = await db
    .insert(readingProgress)
    .values(input)
    .onConflictDoUpdate({
      target: [readingProgress.userId, readingProgress.bookId],
      set: {
        locator: input.locator,
        percent: input.percent,
        deviceId: input.deviceId,
        updatedAt: input.updatedAt,
      },
    })
    .returning();

  if (!row) {
    throw new Error('Progress upsert returned no row');
  }
  return row;
}
