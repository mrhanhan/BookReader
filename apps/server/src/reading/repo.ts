import type { AnnotationColor, Locator } from '@bookr/shared';
import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import type { Database } from '../db/client';
import {
  annotationHistory,
  annotations,
  readingProgress,
  type AnnotationRow,
  type ReadingProgressRow,
} from '../db/schema';

/**
 * A Drizzle transaction over the application database. Repo functions that
 * participate in an annotation edit take this instead of `Database`.
 */
export type ReadingTransaction = PgTransaction<
  NodePgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

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

/** Lists one user's live annotations for a book, most recently edited first. */
export async function listAnnotationRows(
  db: Database,
  userId: string,
  bookId: string,
): Promise<AnnotationRow[]> {
  return db
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.userId, userId),
        eq(annotations.bookId, bookId),
        isNull(annotations.deletedAt),
      ),
    )
    .orderBy(desc(annotations.updatedAt), desc(annotations.id));
}

/** Fields written when a reader creates an annotation. */
export interface InsertAnnotationInput {
  userId: string;
  bookId: string;
  type: AnnotationRow['type'];
  color: AnnotationColor;
  locator: Locator;
  selectedText: string;
  noteText: string | null;
  tags: string[];
  now: Date;
}

/** Inserts a fresh annotation at revision 1 and returns the stored row. */
export async function insertAnnotation(
  db: Database,
  input: InsertAnnotationInput,
): Promise<AnnotationRow> {
  const [row] = await db
    .insert(annotations)
    .values({
      userId: input.userId,
      bookId: input.bookId,
      type: input.type,
      color: input.color,
      locator: input.locator,
      selectedText: input.selectedText,
      noteText: input.noteText,
      tags: input.tags,
      revision: 1,
      updatedAt: input.now,
    })
    .returning();

  if (!row) {
    throw new Error('Annotation insert returned no row');
  }
  return row;
}

/**
 * Locks one live annotation belonging to the given user and book. The predicate
 * deliberately includes the owner: another member's row is indistinguishable
 * from a missing one. Callers must run this inside a transaction.
 */
export async function findOwnedAnnotationForUpdate(
  tx: ReadingTransaction,
  annotationId: string,
  bookId: string,
  userId: string,
): Promise<AnnotationRow | undefined> {
  const [row] = await tx
    .select()
    .from(annotations)
    .where(
      and(
        eq(annotations.id, annotationId),
        eq(annotations.bookId, bookId),
        eq(annotations.userId, userId),
        isNull(annotations.deletedAt),
      ),
    )
    .limit(1)
    .for('update');
  return row;
}

/** Fields written when an annotation edit is applied. */
export interface UpdateAnnotationRowInput {
  color: AnnotationColor;
  noteText: string | null;
  tags: string[];
  revision: number;
  now: Date;
}

/** Applies an edit to an already-locked annotation and returns the updated row. */
export async function updateAnnotationRow(
  tx: ReadingTransaction,
  annotationId: string,
  input: UpdateAnnotationRowInput,
): Promise<AnnotationRow> {
  const [row] = await tx
    .update(annotations)
    .set({
      color: input.color,
      noteText: input.noteText,
      tags: input.tags,
      revision: input.revision,
      updatedAt: input.now,
    })
    .where(eq(annotations.id, annotationId))
    .returning();

  if (!row) {
    throw new Error('Annotation update returned no row');
  }
  return row;
}

/** Fields recorded when an annotation's note text is replaced. */
export interface InsertAnnotationHistoryInput {
  annotationId: string;
  noteText: string;
  editedAt: Date;
  deviceId: string | null;
}

/** Archives the note text an edit is about to replace. */
export async function insertAnnotationHistory(
  tx: ReadingTransaction,
  input: InsertAnnotationHistoryInput,
): Promise<void> {
  await tx.insert(annotationHistory).values(input);
}

/**
 * Soft-deletes one user's live annotation. Returns false when nothing matched,
 * which the service turns into a 404 for missing, deleted and other-user rows.
 */
export async function softDeleteAnnotation(
  db: Database,
  annotationId: string,
  bookId: string,
  userId: string,
  deletedAt: Date,
): Promise<boolean> {
  const rows = await db
    .update(annotations)
    .set({ deletedAt })
    .where(
      and(
        eq(annotations.id, annotationId),
        eq(annotations.bookId, bookId),
        eq(annotations.userId, userId),
        isNull(annotations.deletedAt),
      ),
    )
    .returning({ id: annotations.id });
  return rows.length > 0;
}
