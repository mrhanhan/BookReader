import {
  ERROR_CODES,
  TRASH_RETENTION_DAYS,
  type BookDto,
  type ListBooksQuery,
  type Role,
  type UpdateBookInput,
} from '@bookr/shared';
import { and, eq, inArray, isNotNull, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { auditLogs, books, bookCategories, categories, type BookRow, type NewBook } from '../db/schema';
import { AppError } from '../errors';
import { toBookDto } from './dto';
import {
  deletePurgedBook,
  findBooksDeletedBefore,
  findBookById,
  findCategoriesForBooks,
  findUploaderNames,
  listBooksPage,
  listDeletedBooks,
} from './repo';

/** The authenticated caller, as attached to a request by the auth guard. */
export interface BookActor {
  id: string;
  role: Role;
}

/** Maximum accepted cover image size. */
export const COVER_MAX_BYTES = 5 * 1024 * 1024;

/** Cover URLs are signed for one hour, matching the book DTO. */
const COVER_URL_EXPIRES_SECONDS = 3600;

const DAY_MS = 24 * 60 * 60 * 1000;

/** One page of the shared shelf. */
export interface BookListPage {
  items: BookDto[];
  total: number;
  page: number;
  pageSize: number;
}

/** A cover image already read from the multipart request. */
export interface CoverFile {
  buffer: Buffer;
  contentType: string;
}

/** The only member (or an admin) may change a book they uploaded. */
export function canManage(actor: BookActor, book: Pick<BookRow, 'uploadedBy'>): boolean {
  return actor.role === 'admin' || book.uploadedBy === actor.id;
}

async function requireBook(
  deps: AppDeps,
  bookId: string,
  includeDeleted = false,
): Promise<BookRow> {
  const book = await findBookById(deps.db, bookId, { includeDeleted });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return book;
}

/** Loads a book the actor may modify; missing and trashed books are 404. */
async function requireManageableBook(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
  includeDeleted = false,
): Promise<BookRow> {
  const book = await requireBook(deps, bookId, includeDeleted);
  if (!canManage(actor, book)) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN);
  }
  return book;
}

/** Maps rows to DTOs, loading categories and uploader names in two queries. */
async function toBookDtos(deps: AppDeps, rows: BookRow[]): Promise<BookDto[]> {
  const categoriesByBook = await findCategoriesForBooks(
    deps.db,
    rows.map((row) => row.id),
  );
  const uploaderNames = await findUploaderNames(
    deps.db,
    rows.map((row) => row.uploadedBy),
  );
  return Promise.all(
    rows.map((row) =>
      toBookDto(deps, row, categoriesByBook.get(row.id) ?? [], uploaderNames.get(row.uploadedBy)),
    ),
  );
}

async function toSingleBookDto(deps: AppDeps, book: BookRow): Promise<BookDto> {
  const [dto] = await toBookDtos(deps, [book]);
  return dto!;
}

/** Lists the shared shelf with filtering, sorting and pagination. */
export async function listBooks(deps: AppDeps, query: ListBooksQuery): Promise<BookListPage> {
  const { rows, total } = await listBooksPage(deps.db, query);
  return {
    items: await toBookDtos(deps, rows),
    total,
    page: query.page,
    pageSize: query.pageSize,
  };
}

/** Returns one shelf book, excluding books in the trash. */
export async function getBook(deps: AppDeps, bookId: string): Promise<BookDto> {
  return toSingleBookDto(deps, await requireBook(deps, bookId));
}

/** Metadata patch plus the optional replacement of the book's categories. */
export async function updateBook(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
  patch: UpdateBookInput,
): Promise<BookDto> {
  const book = await requireManageableBook(deps, actor, bookId);
  const now = deps.clock.now();
  const categoryIds = patch.categoryIds ? [...new Set(patch.categoryIds)] : undefined;

  const updated = await deps.db.transaction(async (tx) => {
    if (categoryIds) {
      const found = await tx
        .select({ id: categories.id })
        .from(categories)
        .where(
          and(eq(categories.libraryId, book.libraryId), inArray(categories.id, categoryIds)),
        );
      const known = new Set(found.map((row) => row.id));
      const missing = categoryIds.filter((id) => !known.has(id));
      if (missing.length > 0) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          { categoryIds: missing },
          'One or more categories do not exist',
        );
      }
    }

    const fields: Partial<NewBook> = { updatedAt: now };
    if (patch.title !== undefined) {
      fields.title = patch.title;
    }
    if (patch.author !== undefined) {
      fields.author = patch.author;
    }
    if (patch.description !== undefined) {
      fields.description = patch.description;
    }
    if (patch.status !== undefined) {
      fields.status = patch.status;
    }

    const [row] = await tx
      .update(books)
      .set(fields)
      .where(and(eq(books.id, book.id), isNull(books.deletedAt)))
      .returning();

    if (!row) {
      // The book was trashed between the permission check and the update.
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }

    if (categoryIds) {
      await tx.delete(bookCategories).where(eq(bookCategories.bookId, book.id));
      if (categoryIds.length > 0) {
        await tx
          .insert(bookCategories)
          .values(categoryIds.map((categoryId) => ({ bookId: book.id, categoryId })));
      }
    }

    return row;
  });

  return toSingleBookDto(deps, updated);
}

/** Moves a book to the trash and records who deleted it. */
export async function softDeleteBook(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
): Promise<void> {
  const book = await requireManageableBook(deps, actor, bookId);
  const now = deps.clock.now();

  await deps.db.transaction(async (tx) => {
    const deleted = await tx
      .update(books)
      .set({ deletedAt: now, updatedAt: now })
      .where(and(eq(books.id, book.id), isNull(books.deletedAt)))
      .returning({ id: books.id });

    if (deleted.length === 0) {
      throw new AppError(404, ERROR_CODES.NOT_FOUND);
    }

    await tx.insert(auditLogs).values({
      userId: actor.id,
      action: 'book.delete',
      target: book.id,
    });
  });
}

/** Restores a trashed book; restoring an active book is a no-op. */
export async function restoreBook(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
): Promise<BookDto> {
  const book = await requireManageableBook(deps, actor, bookId, true);
  const now = deps.clock.now();

  const restored = await deps.db.transaction(async (tx): Promise<BookRow | undefined> => {
    const [row] = await tx
      .update(books)
      .set({ deletedAt: null, updatedAt: now })
      .where(and(eq(books.id, book.id), isNotNull(books.deletedAt)))
      .returning();

    if (row) {
      await tx.insert(auditLogs).values({
        userId: actor.id,
        action: 'book.restore',
        target: book.id,
      });
      return row;
    }

    // Another request restored it first; return the current row.
    const [current] = await tx.select().from(books).where(eq(books.id, book.id)).limit(1);
    return current;
  });

  if (!restored) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return toSingleBookDto(deps, restored);
}

/** Everything currently in the trash, shared by all members. */
export async function listTrash(deps: AppDeps): Promise<BookDto[]> {
  return toBookDtos(deps, await listDeletedBooks(deps.db));
}

interface DetectedImage {
  extension: 'png' | 'jpg' | 'webp';
  contentType: string;
}

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);
const RIFF_MAGIC = Buffer.from('RIFF', 'latin1');
const WEBP_MAGIC = Buffer.from('WEBP', 'latin1');

/** Identifies a cover by its leading bytes; the declared type is only a hint. */
function detectImage(buffer: Buffer): DetectedImage | null {
  if (buffer.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { extension: 'png', contentType: 'image/png' };
  }
  if (buffer.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return { extension: 'jpg', contentType: 'image/jpeg' };
  }
  // WebP is a RIFF container whose form type at byte 8 is "WEBP".
  if (
    buffer.subarray(0, RIFF_MAGIC.length).equals(RIFF_MAGIC) &&
    buffer.subarray(8, 8 + WEBP_MAGIC.length).equals(WEBP_MAGIC)
  ) {
    return { extension: 'webp', contentType: 'image/webp' };
  }
  return null;
}

/** Stores a validated cover under a stable key and returns a fresh signed URL. */
export async function replaceCover(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
  file: CoverFile,
): Promise<{ coverUrl: string }> {
  const book = await requireManageableBook(deps, actor, bookId);

  if (file.buffer.length === 0) {
    throw new AppError(422, ERROR_CODES.INVALID_FILE);
  }
  if (file.buffer.length > COVER_MAX_BYTES) {
    throw new AppError(
      413,
      ERROR_CODES.VALIDATION_FAILED,
      { maxBytes: COVER_MAX_BYTES },
      'Cover image is too large',
    );
  }

  const image = detectImage(file.buffer);
  if (!image) {
    throw new AppError(422, ERROR_CODES.INVALID_FILE);
  }

  const coverKey = `covers/${book.id}.${image.extension}`;
  await deps.storage.putObject(coverKey, file.buffer, image.contentType);

  const updated = await deps.db
    .update(books)
    .set({ coverKey, updatedAt: deps.clock.now() })
    .where(and(eq(books.id, book.id), isNull(books.deletedAt)))
    .returning({ id: books.id });

  if (updated.length === 0) {
    // The book was trashed while the image was in flight; keep storage clean.
    await deps.storage.delete(coverKey).catch(() => undefined);
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }

  // Replacing a PNG with a JPEG (or the reverse) leaves the old key behind.
  if (book.coverKey && book.coverKey !== coverKey) {
    await deps.storage.delete(book.coverKey).catch(() => undefined);
  }

  return { coverUrl: await deps.storage.presignGet(coverKey, COVER_URL_EXPIRES_SECONDS) };
}

/**
 * Permanently removes books that have sat in the trash past the retention
 * window, along with every stored object they reference.
 */
export async function cleanupTrash(deps: AppDeps): Promise<number> {
  const cutoff = new Date(deps.clock.now().getTime() - TRASH_RETENTION_DAYS * DAY_MS);
  const expired = await findBooksDeletedBefore(deps.db, cutoff);

  let removed = 0;
  for (const book of expired) {
    const keys = [book.fileKey, book.coverKey, book.epubKey, book.textLayerKey, book.reflowKey].filter(
      (key): key is string => key !== null,
    );

    try {
      for (const key of keys) {
        await deps.storage.delete(key);
      }
    } catch {
      // Leave the row for the next sweep: deleting the row first would orphan
      // the remaining objects. Deletes that already succeeded are harmless to
      // repeat.
      continue;
    }

    if (await deletePurgedBook(deps.db, book.id, cutoff)) {
      removed += 1;
    }
  }

  return removed;
}
