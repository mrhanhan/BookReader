import {
  ERROR_CODES,
  MAX_UPLOAD_BYTES,
  createUploadSchema,
  type BookDto,
  type BookFormat,
  type CreateUploadResponse,
} from '@bookr/shared';
import { and, eq, gt, isNull, lt, sql } from 'drizzle-orm';
import type { z } from 'zod';
import type { AppDeps } from '../app';
import { toBookDto } from '../books/dto';
import { books, uploadSessions, users, type BookRow } from '../db/schema';
import { AppError } from '../errors';
import { getLibrary } from '../library/service';
import { StorageObjectNotFoundError } from '../storage/types';
import { magicBytesNeeded, sniffMagic } from './magic';

export type CreateUploadInput = z.infer<typeof createUploadSchema>;

/** Presigned PUT URLs are valid for 15 minutes. */
export const UPLOAD_URL_EXPIRES_SECONDS = 900;

/** Unfinished upload sessions expire after one day. */
export const UPLOAD_SESSION_TTL_MS = 24 * 60 * 60 * 1000;

/** Advisory lock that serialises the duplicate/quota check and session insert. */
const UPLOAD_QUOTA_LOCK_ID = 741_852_963;

const FORMAT_BY_EXTENSION: Record<string, BookFormat> = {
  pdf: 'pdf',
  epub: 'epub',
  mobi: 'mobi',
  azw3: 'azw3',
};

const CONTENT_TYPE_BY_FORMAT: Record<BookFormat, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
};

/** Resolves the book format from the filename extension and checks it matches the declared type. */
export function formatForUpload(filename: string, contentType: string): BookFormat {
  const dot = filename.lastIndexOf('.');
  const extension = dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
  const format = FORMAT_BY_EXTENSION[extension];
  if (!format || CONTENT_TYPE_BY_FORMAT[format] !== contentType) {
    throw new AppError(
      400,
      ERROR_CODES.VALIDATION_FAILED,
      { filename, contentType },
      'The filename extension does not match the declared content type',
    );
  }
  return format;
}

/** Derives a display title by dropping the final extension and trimming space. */
export function titleFromFilename(filename: string): string {
  const trimmed = filename.trim();
  const dot = trimmed.lastIndexOf('.');
  const base = dot > 0 ? trimmed.slice(0, dot) : trimmed;
  return base.trim() || trimmed;
}

function isUniqueViolation(error: unknown): boolean {
  let current: unknown = error;
  for (let depth = 0; depth < 4 && current; depth += 1) {
    if (typeof current === 'object' && current !== null) {
      if ((current as { code?: unknown }).code === '23505') {
        return true;
      }
      current = (current as { cause?: unknown }).cause;
    } else {
      break;
    }
  }
  return false;
}

async function failSession(
  deps: AppDeps,
  session: { id: string; objectKey: string },
): Promise<void> {
  // Claim the transition first: when two requests complete the same session,
  // the loser must not delete the object the winner's book now references.
  const failed = await deps.db
    .update(uploadSessions)
    .set({ status: 'failed' })
    .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.status, 'created')))
    .returning({ id: uploadSessions.id });

  if (failed.length === 0) {
    return;
  }

  // A storage outage must not hide the real validation error; the cleanup job
  // will remove any object this delete misses.
  await deps.storage.delete(session.objectKey).catch(() => undefined);
}

/** Inserts an upload session and returns a presigned PUT target. */
export async function createUpload(
  deps: AppDeps,
  userId: string,
  input: CreateUploadInput,
): Promise<CreateUploadResponse> {
  const library = await getLibrary(deps);
  const format = formatForUpload(input.filename, input.contentType);
  const uploadId = deps.ids.newId();
  const objectKey = `library/${library.id}/books/${uploadId}/original.${format}`;
  const now = deps.clock.now();
  const expiresAt = new Date(now.getTime() + UPLOAD_SESSION_TTL_MS);

  await deps.db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(${UPLOAD_QUOTA_LOCK_ID})`);

    const [duplicate] = await tx
      .select({ id: books.id })
      .from(books)
      .where(
        and(
          eq(books.libraryId, library.id),
          eq(books.sha256, input.sha256),
          isNull(books.deletedAt),
        ),
      )
      .limit(1);

    if (duplicate) {
      throw new AppError(409, ERROR_CODES.DUPLICATE_BOOK, { existingBookId: duplicate.id });
    }

    const [bookUsage] = await tx
      .select({
        libraryUsed: sql<string>`coalesce(sum(${books.size}), 0)`,
        memberUsed: sql<string>`coalesce(sum(case when ${books.uploadedBy} = ${userId} then ${books.size} else 0 end), 0)`,
      })
      .from(books)
      .where(and(eq(books.libraryId, library.id), isNull(books.deletedAt)));

    const [sessionUsage] = await tx
      .select({
        libraryUsed: sql<string>`coalesce(sum(${uploadSessions.size}), 0)`,
        memberUsed: sql<string>`coalesce(sum(case when ${uploadSessions.userId} = ${userId} then ${uploadSessions.size} else 0 end), 0)`,
      })
      .from(uploadSessions)
      .where(
        and(eq(uploadSessions.status, 'created'), gt(uploadSessions.expiresAt, now)),
      );

    const [member] = await tx
      .select({ uploadQuotaBytes: users.uploadQuotaBytes })
      .from(users)
      .where(eq(users.id, userId))
      .limit(1);

    const libraryUsed =
      Number(bookUsage?.libraryUsed ?? 0) + Number(sessionUsage?.libraryUsed ?? 0);
    const memberUsed =
      Number(bookUsage?.memberUsed ?? 0) + Number(sessionUsage?.memberUsed ?? 0);
    // Admins may lower an individual member's quota; the server-wide config
    // value remains a hard ceiling.
    const memberQuota = Math.min(
      deps.config.memberUploadQuotaBytes,
      member?.uploadQuotaBytes ?? deps.config.memberUploadQuotaBytes,
    );

    if (
      libraryUsed + input.size > deps.config.libraryQuotaBytes ||
      memberUsed + input.size > memberQuota
    ) {
      throw new AppError(409, ERROR_CODES.QUOTA_EXCEEDED, {
        libraryUsedBytes: libraryUsed,
        memberUsedBytes: memberUsed,
      });
    }

    await tx.insert(uploadSessions).values({
      id: uploadId,
      userId,
      filename: input.filename,
      size: input.size,
      sha256: input.sha256,
      contentType: input.contentType,
      format,
      objectKey,
      expiresAt,
    });
  });

  const putUrl = await deps.storage.presignPut(
    objectKey,
    input.contentType,
    UPLOAD_URL_EXPIRES_SECONDS,
  );

  return { uploadId, putUrl, expiresAt: expiresAt.toISOString() };
}

/** A session row loaded from Postgres. */
type UploadSessionRow = typeof uploadSessions.$inferSelect;

/**
 * Checks the stored object's size and signature. Returns false for user
 * errors (missing object, wrong size, bad magic); storage transport failures
 * propagate so the caller can retry without burning the session.
 */
async function storedObjectMatches(
  deps: AppDeps,
  session: Pick<UploadSessionRow, 'objectKey' | 'size' | 'format'>,
): Promise<boolean> {
  const stored = await deps.storage.head(session.objectKey);
  if (!stored) {
    return false;
  }
  if (
    stored.size !== session.size ||
    stored.size > MAX_UPLOAD_BYTES ||
    session.size > MAX_UPLOAD_BYTES
  ) {
    return false;
  }

  const needed = magicBytesNeeded(session.format);

  let head: Buffer;
  try {
    head = await deps.storage.readFirstBytes(session.objectKey, needed);
  } catch (error) {
    if (error instanceof StorageObjectNotFoundError) {
      return false;
    }
    throw error;
  }

  // A short object simply fails the signature check; a short read caused by a
  // storage fault also fails it, which is safe.
  return sniffMagic(head, session.format);
}

type CompletionOutcome =
  | { kind: 'completed'; book: BookRow }
  | { kind: 'invalid'; objectKey: string };

/**
 * Validates the uploaded object and turns the session into a book row.
 * The session row is locked from the status check until the book insert
 * commits, so cleanup cannot expire it (and delete its object) in between.
 * User-caused failures mark the session failed and remove the object so the
 * same content can be retried and the quota is released.
 */
export async function completeUpload(
  deps: AppDeps,
  userId: string,
  uploadId: string,
): Promise<BookDto> {
  const now = deps.clock.now();
  const library = await getLibrary(deps);
  let lockedSession: UploadSessionRow | undefined;

  let outcome: CompletionOutcome;
  try {
    outcome = await deps.db.transaction(async (tx) => {
      const [session] = await tx
        .select()
        .from(uploadSessions)
        .where(and(eq(uploadSessions.id, uploadId), eq(uploadSessions.userId, userId)))
        .limit(1)
        .for('update');

      // Sessions of other members are indistinguishable from missing ones.
      if (!session) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND);
      }
      if (session.status !== 'created') {
        throw new AppError(409, ERROR_CODES.CONFLICT);
      }
      lockedSession = session;

      if (session.expiresAt.getTime() <= now.getTime()) {
        throw new AppError(409, ERROR_CODES.CONFLICT);
      }

      if (!(await storedObjectMatches(deps, session))) {
        const failed = await tx
          .update(uploadSessions)
          .set({ status: 'failed' })
          .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.status, 'created')))
          .returning({ objectKey: uploadSessions.objectKey });

        if (failed.length !== 1) {
          throw new Error('Upload session changed while holding its lock');
        }
        return { kind: 'invalid' as const, objectKey: failed[0]!.objectKey };
      }

      const [inserted] = await tx
        .insert(books)
        .values({
          libraryId: library.id,
          uploadedBy: userId,
          title: titleFromFilename(session.filename),
          format: session.format,
          originalFilename: session.filename,
          size: session.size,
          sha256: session.sha256,
          fileKey: session.objectKey,
          status: 'unread',
          metadataStatus: 'pending',
          conversionStatus:
            session.format === 'mobi' || session.format === 'azw3' ? 'pending' : 'none',
        })
        .returning();

      if (!inserted) {
        throw new Error('The book row could not be inserted');
      }

      const completed = await tx
        .update(uploadSessions)
        .set({ status: 'completed', completedAt: now })
        .where(and(eq(uploadSessions.id, session.id), eq(uploadSessions.status, 'created')))
        .returning({ id: uploadSessions.id });

      if (completed.length !== 1) {
        throw new Error('Upload session changed while holding its lock');
      }

      return { kind: 'completed' as const, book: inserted };
    });
  } catch (error) {
    if (isUniqueViolation(error) && lockedSession) {
      const [existing] = await deps.db
        .select({ id: books.id })
        .from(books)
        .where(
          and(
            eq(books.libraryId, library.id),
            eq(books.sha256, lockedSession.sha256),
            isNull(books.deletedAt),
          ),
        )
        .limit(1);

      await failSession(deps, lockedSession);
      throw new AppError(
        409,
        ERROR_CODES.DUPLICATE_BOOK,
        existing ? { existingBookId: existing.id } : undefined,
      );
    }
    throw error;
  }

  if (outcome.kind === 'invalid') {
    await deps.storage.delete(outcome.objectKey).catch(() => undefined);
    throw new AppError(422, ERROR_CODES.INVALID_FILE);
  }

  const book = outcome.book;
  await deps.jobs.enqueue({ type: 'metadata', bookId: book.id });
  if (book.format === 'mobi' || book.format === 'azw3') {
    await deps.jobs.enqueue({ type: 'convert', bookId: book.id });
  }

  return toBookDto(deps, book, []);
}

/** Removes objects of abandoned sessions and marks those sessions expired. */
export async function cleanupExpiredUploads(deps: AppDeps): Promise<number> {
  const now = deps.clock.now();
  // Transition first, then delete: a session that a user completed in the
  // meantime keeps its object because the update no longer matches it.
  const expired = await deps.db
    .update(uploadSessions)
    .set({ status: 'expired' })
    .where(and(eq(uploadSessions.status, 'created'), lt(uploadSessions.expiresAt, now)))
    .returning({ objectKey: uploadSessions.objectKey });

  for (const session of expired) {
    await deps.storage.delete(session.objectKey).catch(() => undefined);
  }

  return expired.length;
}
