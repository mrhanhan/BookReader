import type { AnnotationColor, Locator } from '@bookr/shared';
import { and, desc, eq, inArray, isNull } from 'drizzle-orm';
import type { Database, Transaction as ReadingTransaction } from '../db/client';
import {
  annotationHistory,
  annotations,
  bookmarks,
  readingProgress,
  type AnnotationRow,
  type BookmarkRow,
  type ReadingProgressRow,
} from '../db/schema';

/**
 * Repository's name for the shared transaction type. Callers that only edit
 * reading data can keep importing `ReadingTransaction` from here.
 */
export type { ReadingTransaction };

/** Fields written by a progress upsert. */
export interface UpsertProgressInput {
  userId: string;
  bookId: string;
  locator: ReadingProgressRow['locator'];
  percent: number;
  deviceId: string | null;
  updatedAt: Date;
  clientUpdatedAt: Date;
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
  tx: ReadingTransaction,
  input: UpsertProgressInput,
): Promise<ReadingProgressRow> {
  const [row] = await tx
    .insert(readingProgress)
    .values(input)
    .onConflictDoUpdate({
      target: [readingProgress.userId, readingProgress.bookId],
      set: {
        locator: input.locator,
        percent: input.percent,
        deviceId: input.deviceId,
        updatedAt: input.updatedAt,
        clientUpdatedAt: input.clientUpdatedAt,
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
  /** Client-chosen id, used when a pushed change creates the row. */
  id?: string;
  userId: string;
  bookId: string;
  type: AnnotationRow['type'];
  color: AnnotationColor;
  locator: Locator;
  selectedText: string;
  noteText: string | null;
  tags: string[];
  now: Date;
  clientUpdatedAt: Date;
}

/** Inserts a fresh annotation at revision 1 and returns the stored row. */
export async function insertAnnotation(
  tx: ReadingTransaction,
  input: InsertAnnotationInput,
): Promise<AnnotationRow> {
  const [row] = await tx
    .insert(annotations)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
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
      clientUpdatedAt: input.clientUpdatedAt,
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

/**
 * Locks one annotation by id regardless of owner or tombstone. Sync needs the
 * raw row to decide ownership, ordering and resurrection; callers must run
 * this inside a transaction.
 */
export async function findAnnotationRowById(
  tx: ReadingTransaction,
  annotationId: string,
): Promise<AnnotationRow | undefined> {
  const [row] = await tx
    .select()
    .from(annotations)
    .where(eq(annotations.id, annotationId))
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
  clientUpdatedAt: Date;
  /** Sync upserts clear the tombstone; REST edits leave it untouched. */
  deletedAt?: Date | null;
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
      clientUpdatedAt: input.clientUpdatedAt,
      ...(input.deletedAt !== undefined ? { deletedAt: input.deletedAt } : {}),
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
 * Soft-deletes one user's live annotation and returns the stored row so the
 * caller can log its last state. An undefined result means nothing matched,
 * which the service turns into a 404 for missing, deleted and other-user rows.
 */
export async function softDeleteAnnotation(
  tx: ReadingTransaction,
  annotationId: string,
  bookId: string,
  userId: string,
  deletedAt: Date,
  clientUpdatedAt: Date = deletedAt,
): Promise<AnnotationRow | undefined> {
  const [row] = await tx
    .update(annotations)
    .set({ deletedAt, clientUpdatedAt })
    .where(
      and(
        eq(annotations.id, annotationId),
        eq(annotations.bookId, bookId),
        eq(annotations.userId, userId),
        isNull(annotations.deletedAt),
      ),
    )
    .returning();
  return row;
}

/** Lists one user's live bookmarks for a book, newest first. */
export async function listBookmarkRows(
  db: Database,
  userId: string,
  bookId: string,
): Promise<BookmarkRow[]> {
  return db
    .select()
    .from(bookmarks)
    .where(
      and(
        eq(bookmarks.userId, userId),
        eq(bookmarks.bookId, bookId),
        isNull(bookmarks.deletedAt),
      ),
    )
    .orderBy(desc(bookmarks.createdAt), desc(bookmarks.id));
}

/** Fields written when a reader creates a bookmark. */
export interface InsertBookmarkInput {
  /** Client-chosen id, used when a pushed change creates the row. */
  id?: string;
  userId: string;
  bookId: string;
  locator: Locator;
  label: string | null;
  now: Date;
  clientUpdatedAt: Date;
}

/** Inserts a fresh bookmark and returns the stored row. */
export async function insertBookmark(
  tx: ReadingTransaction,
  input: InsertBookmarkInput,
): Promise<BookmarkRow> {
  const [row] = await tx
    .insert(bookmarks)
    .values({
      ...(input.id !== undefined ? { id: input.id } : {}),
      userId: input.userId,
      bookId: input.bookId,
      locator: input.locator,
      label: input.label,
      updatedAt: input.now,
      clientUpdatedAt: input.clientUpdatedAt,
    })
    .returning();

  if (!row) {
    throw new Error('Bookmark insert returned no row');
  }
  return row;
}

/**
 * Locks one bookmark by id regardless of owner or tombstone. Sync needs the
 * raw row to decide ownership, ordering and resurrection; callers must run
 * this inside a transaction.
 */
export async function findBookmarkRowById(
  tx: ReadingTransaction,
  bookmarkId: string,
): Promise<BookmarkRow | undefined> {
  const [row] = await tx
    .select()
    .from(bookmarks)
    .where(eq(bookmarks.id, bookmarkId))
    .limit(1)
    .for('update');
  return row;
}

/**
 * Renames one user's live bookmark. Returns undefined when nothing matched,
 * which the service turns into a 404 for missing, deleted and other-user rows.
 */
export async function updateBookmarkRow(
  tx: ReadingTransaction,
  bookmarkId: string,
  bookId: string,
  userId: string,
  label: string | null,
  updatedAt: Date,
  clientUpdatedAt: Date,
): Promise<BookmarkRow | undefined> {
  const [row] = await tx
    .update(bookmarks)
    .set({ label, updatedAt, clientUpdatedAt })
    .where(
      and(
        eq(bookmarks.id, bookmarkId),
        eq(bookmarks.bookId, bookId),
        eq(bookmarks.userId, userId),
        isNull(bookmarks.deletedAt),
      ),
    )
    .returning();
  return row;
}

/** Fields written when a pushed bookmark change updates the stored row. */
export interface UpdateBookmarkByIdInput {
  label: string | null;
  updatedAt: Date;
  clientUpdatedAt: Date;
  /** Sync upserts clear the tombstone so a deleted bookmark can come back. */
  deletedAt: Date | null;
}

/**
 * Updates a bookmark by id after the caller has locked and checked its owner.
 * Unlike `updateBookmarkRow` it also sees tombstoned rows, which is what lets
 * a newer pushed upsert resurrect them.
 */
export async function updateBookmarkRowById(
  tx: ReadingTransaction,
  bookmarkId: string,
  input: UpdateBookmarkByIdInput,
): Promise<BookmarkRow> {
  const [row] = await tx
    .update(bookmarks)
    .set({
      label: input.label,
      updatedAt: input.updatedAt,
      clientUpdatedAt: input.clientUpdatedAt,
      deletedAt: input.deletedAt,
    })
    .where(eq(bookmarks.id, bookmarkId))
    .returning();

  if (!row) {
    throw new Error('Bookmark update returned no row');
  }
  return row;
}

/**
 * Soft-deletes one user's live bookmark and returns the stored row so the
 * caller can log its last state. An undefined result means nothing matched,
 * which the service turns into a 404 for missing, deleted and other-user rows.
 */
export async function softDeleteBookmark(
  tx: ReadingTransaction,
  bookmarkId: string,
  bookId: string,
  userId: string,
  deletedAt: Date,
  clientUpdatedAt: Date = deletedAt,
): Promise<BookmarkRow | undefined> {
  const [row] = await tx
    .update(bookmarks)
    .set({ deletedAt, clientUpdatedAt })
    .where(
      and(
        eq(bookmarks.id, bookmarkId),
        eq(bookmarks.bookId, bookId),
        eq(bookmarks.userId, userId),
        isNull(bookmarks.deletedAt),
      ),
    )
    .returning();
  return row;
}
