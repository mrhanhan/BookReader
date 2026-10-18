import {
  ERROR_CODES,
  MAX_REFLOW_PACK_BYTES,
  reflowPackSchema,
  reflowPackSummary,
  reflowUploadCreateSchema,
  type CompleteReflowUploadResponse,
  type CreateReflowUploadResponse,
  type ReflowFileInfo,
} from '@bookr/shared';
import { and, eq, isNull, lt } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { books, reflowUploads } from '../db/schema';
import { AppError } from '../errors';
import { StorageObjectNotFoundError } from '../storage/types';
import { canManage, getBook, type BookActor } from './service';
import { findBookById } from './repo';

/** Presigned pack upload URLs are valid for 15 minutes. */
export const REFLOW_URL_EXPIRES_SECONDS = 900;

/** Signed pack download URLs are valid for one hour. */
export const REFLOW_PACK_URL_EXPIRES_SECONDS = 3600;

/** Unfinished reflow upload sessions expire after one day. */
export const REFLOW_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** The pack a session must upload, validated against the book's sha256. */
export interface CreateReflowUploadInput {
  size: number;
  sha256: string;
}

/**
 * Records an upload session for a reflow pack. Only the uploader or an admin
 * may replace a book's pack, and the declared source hash must match the book
 * so a pack can never be attached to the wrong file.
 */
export async function createReflowUpload(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
  input: CreateReflowUploadInput,
): Promise<CreateReflowUploadResponse> {
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  if (book.format !== 'pdf') {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      { format: book.format },
      'Reflow packs are only supported for PDF books',
    );
  }
  if (!canManage(actor, book)) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN);
  }

  const parsed = reflowUploadCreateSchema.parse(input);
  if (parsed.sha256 !== book.sha256) {
    throw new AppError(422, ERROR_CODES.REFLOW_INVALID, { reason: 'pack/source-mismatch' });
  }

  const uploadId = deps.ids.newId();
  const objectKey = `library/${book.libraryId}/books/${book.id}/reflow/${uploadId}.json`;
  const expiresAt = new Date(deps.clock.now().getTime() + REFLOW_SESSION_TTL_MS);

  // At most one outstanding session per book. A book row lock serialises
  // concurrent creates, so every earlier `created` session is expired and its
  // presigned target invalidated before the new one exists. Objects are only
  // removed after the commit: a failed insert must not delete anything.
  const supersededKeys = await deps.db.transaction(async (tx) => {
    const [lockedBook] = await tx
      .select({ id: books.id })
      .from(books)
      .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
      .limit(1)
      .for('update');

    // The book may have been trashed since the permission check.
    if (!lockedBook) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }

    const superseded = await tx
      .update(reflowUploads)
      .set({ status: 'expired' })
      .where(
        and(eq(reflowUploads.bookId, bookId), eq(reflowUploads.status, 'created')),
      )
      .returning({ objectKey: reflowUploads.objectKey });

    await tx.insert(reflowUploads).values({
      id: uploadId,
      bookId: book.id,
      userId: actor.id,
      objectKey,
      size: parsed.size,
      sha256: parsed.sha256,
      expiresAt,
    });

    return superseded.map((session) => session.objectKey);
  });

  for (const key of supersededKeys) {
    await deps.storage.delete(key).catch(() => undefined);
  }

  const upload = await deps.storage.presignPost(
    objectKey,
    'application/json',
    parsed.size,
    REFLOW_URL_EXPIRES_SECONDS,
  );

  return { uploadId, upload, expiresAt: expiresAt.toISOString() };
}

/**
 * Claims the `created -> failed` transition and removes the bytes. The compare
 * and swap keeps a concurrent successful completion in charge of the object:
 * only the request that actually owns the transition deletes it.
 */
async function rejectSession(
  deps: AppDeps,
  sessionId: string,
  objectKey: string,
  reason: string,
): Promise<never> {
  const failed = await deps.db
    .update(reflowUploads)
    .set({ status: 'failed' })
    .where(and(eq(reflowUploads.id, sessionId), eq(reflowUploads.status, 'created')))
    .returning({ id: reflowUploads.id });

  if (failed.length > 0) {
    // A storage outage must not hide the validation error; the daily sweep
    // removes any object left behind.
    await deps.storage.delete(objectKey).catch(() => undefined);
  }

  throw new AppError(422, ERROR_CODES.REFLOW_INVALID, { reason });
}

/**
 * Validates an uploaded pack and attaches it to the book. Every rejection
 * happens before the transaction, so an invalid pack never touches the book
 * row or the pack it currently points at.
 */
export async function completeReflowUpload(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
  uploadId: string,
): Promise<CompleteReflowUploadResponse> {
  const now = deps.clock.now();
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  const [session] = await deps.db
    .select()
    .from(reflowUploads)
    .where(
      and(
        eq(reflowUploads.id, uploadId),
        eq(reflowUploads.bookId, bookId),
        eq(reflowUploads.userId, actor.id),
      ),
    )
    .limit(1);

  if (!session) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  if (session.status !== 'created' || session.expiresAt.getTime() <= now.getTime()) {
    throw new AppError(409, ERROR_CODES.CONFLICT);
  }

  const stored = await deps.storage.head(session.objectKey);
  if (!stored) {
    return rejectSession(deps, session.id, session.objectKey, 'pack/missing');
  }
  if (stored.size !== session.size || stored.size > MAX_REFLOW_PACK_BYTES) {
    return rejectSession(deps, session.id, session.objectKey, 'pack/size');
  }

  let buffer: Buffer;
  try {
    buffer = await deps.storage.getObject(session.objectKey);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return rejectSession(deps, session.id, session.objectKey, 'pack/missing');
    }
    throw error;
  }
  if (buffer.length !== session.size || buffer.length > MAX_REFLOW_PACK_BYTES) {
    return rejectSession(deps, session.id, session.objectKey, 'pack/size');
  }

  let body: unknown;
  try {
    body = JSON.parse(buffer.toString('utf8'));
  } catch {
    // Never include the parse error or the payload: it may contain pack text.
    return rejectSession(deps, session.id, session.objectKey, 'pack/invalid');
  }

  const parsed = reflowPackSchema.safeParse(body);
  if (!parsed.success) {
    return rejectSession(deps, session.id, session.objectKey, 'pack/invalid');
  }
  const pack = parsed.data;
  if (pack.source.sha256 !== book.sha256) {
    return rejectSession(deps, session.id, session.objectKey, 'pack/source-mismatch');
  }

  const previousKey = await deps.db.transaction(async (tx) => {
    // Lock the book first and the session second, matching createReflowUpload
    // so the two paths can never acquire the same pair in opposite order.
    const [currentBook] = await tx
      .select()
      .from(books)
      .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
      .limit(1)
      .for('update');

    if (!currentBook) {
      // A concurrent trash wins the race and behaves like a missing book.
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    if (!canManage(actor, currentBook)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN);
    }

    // Time is re-read under the lock: validation above may have taken long
    // enough for the session to expire.
    const lockedNow = deps.clock.now();

    const [locked] = await tx
      .select()
      .from(reflowUploads)
      .where(eq(reflowUploads.id, session.id))
      .limit(1)
      .for('update');

    if (!locked) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    // A concurrent completion (or cleanup) won the race; the book already
    // reflects whichever transition won, so this request changes nothing.
    if (
      locked.status !== 'created' ||
      locked.expiresAt.getTime() <= lockedNow.getTime()
    ) {
      throw new AppError(409, ERROR_CODES.CONFLICT);
    }

    await tx
      .update(books)
      .set({
        reflowKey: session.objectKey,
        reflowSchemaVersion: pack.schemaVersion,
        reflowPageCount: pack.pages.length,
        reflowUpdatedAt: lockedNow,
      })
      .where(eq(books.id, bookId));

    const completed = await tx
      .update(reflowUploads)
      .set({ status: 'completed', completedAt: lockedNow })
      .where(and(eq(reflowUploads.id, session.id), eq(reflowUploads.status, 'created')))
      .returning({ id: reflowUploads.id });

    if (completed.length !== 1) {
      throw new Error('Reflow upload session changed while holding its lock');
    }

    return currentBook.reflowKey;
  });

  if (previousKey !== null && previousKey !== session.objectKey) {
    await deps.storage.delete(previousKey).catch(() => undefined);
  }

  return {
    book: await getBook(deps, bookId, actor.id),
    pack: reflowPackSummary(pack),
  };
}

/** Removes a book's pack and clears the metadata columns that describe it. */
export async function deleteReflowPack(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
): Promise<void> {
  // Read the key under the same row lock as the clear. A plain pre-read could
  // see a stale key and delete the wrong object when a completion commits in
  // between, orphaning the pack the book now points at. PostgreSQL's
  // `RETURNING` reports post-update values, so it cannot supply the old key.
  const removedKey = await deps.db.transaction(async (tx) => {
    const [current] = await tx
      .select({ reflowKey: books.reflowKey, uploadedBy: books.uploadedBy })
      .from(books)
      .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
      .limit(1)
      .for('update');

    // A concurrent trash wins the race and behaves like a missing book; its
    // row still owns the object, so no bytes are deleted.
    if (!current) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }
    if (!canManage(actor, current)) {
      throw new AppError(403, ERROR_CODES.FORBIDDEN);
    }

    await tx
      .update(books)
      .set({
        reflowKey: null,
        reflowSchemaVersion: null,
        reflowPageCount: null,
        reflowUpdatedAt: null,
      })
      .where(eq(books.id, bookId));

    return current.reflowKey;
  });

  if (removedKey !== null) {
    await deps.storage.delete(removedKey).catch(() => undefined);
  }
}

/** Signs the pack for download, exposing only the metadata a reader needs. */
export async function getReflowFile(
  deps: AppDeps,
  bookId: string,
): Promise<ReflowFileInfo> {
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  if (
    book.reflowKey === null ||
    book.reflowSchemaVersion === null ||
    book.reflowPageCount === null
  ) {
    throw new AppError(409, ERROR_CODES.REFLOW_NOT_READY);
  }

  const url = await deps.storage.presignGet(book.reflowKey, REFLOW_PACK_URL_EXPIRES_SECONDS);
  return {
    url,
    schemaVersion: book.reflowSchemaVersion,
    pageCount: book.reflowPageCount,
    expiresIn: REFLOW_PACK_URL_EXPIRES_SECONDS,
  };
}

/** Marks abandoned sessions expired, then removes the objects they own. */
export async function cleanupExpiredReflowUploads(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  // Transition first, then delete: a session completed in the meantime is no
  // longer `created`, so the update skips it and its object stays in place.
  const expired = await deps.db
    .update(reflowUploads)
    .set({ status: 'expired' })
    .where(and(eq(reflowUploads.status, 'created'), lt(reflowUploads.expiresAt, now)))
    .returning({ objectKey: reflowUploads.objectKey });

  for (const session of expired) {
    await deps.storage.delete(session.objectKey).catch(() => undefined);
  }

  return expired.length;
}
