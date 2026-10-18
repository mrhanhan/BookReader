import type { CategoryDto, ListBooksQuery } from '@bookr/shared';
import {
  and,
  asc,
  desc,
  eq,
  getTableColumns,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { Database } from '../db/client';
import {
  bookCategories,
  books,
  categories,
  readingProgress,
  users,
  type BookRow,
} from '../db/schema';

/** Escapes the wildcards of a LIKE pattern so query text matches literally. */
function escapeLike(value: string): string {
  return value.replace(/[\\%_]/g, (char) => `\\${char}`);
}

/**
 * Builds the shelf filter. Soft-deleted books are excluded everywhere and a
 * category filter uses EXISTS so a book never appears more than once.
 */
function listConditions(query: ListBooksQuery): SQL[] {
  const conditions: SQL[] = [isNull(books.deletedAt)];

  const text = query.query?.trim();
  if (text) {
    const pattern = `%${escapeLike(text)}%`;
    const titleMatches = ilike(books.title, pattern);
    const authorMatches = ilike(books.author, pattern);
    conditions.push(or(titleMatches, authorMatches)!);
  }

  if (query.format) {
    conditions.push(eq(books.format, query.format));
  }
  if (query.status) {
    conditions.push(eq(books.status, query.status));
  }
  if (query.categoryId) {
    conditions.push(
      sql`exists (
        select 1 from ${bookCategories}
        where ${bookCategories.bookId} = ${books.id}
          and ${bookCategories.categoryId} = ${query.categoryId}
      )`,
    );
  }

  return conditions;
}

function orderBy(sort: ListBooksQuery['sort']): SQL[] {
  switch (sort) {
    case 'title':
      return [asc(books.title), asc(books.id)];
    case 'added':
      return [desc(books.createdAt), desc(books.id)];
    case 'recent':
      // Per-user: the viewer's last read position wins, and books they have
      // not opened fall back to import time.
      return [
        desc(sql`coalesce(${readingProgress.updatedAt}, ${books.createdAt})`),
        desc(books.id),
      ];
  }
}

/** One page of shelf books plus the unpaginated total for the same filter. */
export async function listBooksPage(
  db: Database,
  query: ListBooksQuery,
  viewerId: string,
): Promise<{ rows: BookRow[]; total: number }> {
  const where = and(...listConditions(query));

  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(books)
    .where(where);

  // The join is always present so `sort=recent` can order by this viewer's
  // progress; the composite primary key guarantees at most one matching row.
  const rows = await db
    .select(getTableColumns(books))
    .from(books)
    .leftJoin(
      readingProgress,
      and(eq(readingProgress.bookId, books.id), eq(readingProgress.userId, viewerId)),
    )
    .where(where)
    .orderBy(...orderBy(query.sort))
    .limit(query.pageSize)
    .offset((query.page - 1) * query.pageSize);

  return { rows, total: Number(counted?.total ?? 0) };
}

/** Loads a book by id, optionally including rows that sit in the trash. */
export async function findBookById(
  db: Database,
  bookId: string,
  options: { includeDeleted: boolean },
): Promise<BookRow | undefined> {
  const where = options.includeDeleted
    ? eq(books.id, bookId)
    : and(eq(books.id, bookId), isNull(books.deletedAt));

  const [book] = await db.select().from(books).where(where).limit(1);
  return book;
}

/** Everything currently in the trash, most recently deleted first. */
export async function listDeletedBooks(db: Database): Promise<BookRow[]> {
  return db
    .select()
    .from(books)
    .where(isNotNull(books.deletedAt))
    .orderBy(desc(books.deletedAt), desc(books.id));
}

/** Storage keys of a row removed by the trash purge. */
export interface PurgedBook {
  id: string;
  fileKey: string | null;
  coverKey: string | null;
  epubKey: string | null;
  textLayerKey: string | null;
  reflowKey: string | null;
}

/**
 * Removes every book past the retention window and returns the storage keys
 * that belonged to them. The rows commit before objects are deleted, so a
 * restore that wins the race keeps both the row and its files; a restore that
 * loses finds no row and sees a 404.
 */
export async function purgeBooksDeletedBefore(
  db: Database,
  cutoff: Date,
): Promise<PurgedBook[]> {
  return db.transaction((tx) =>
    tx
      .delete(books)
      .where(and(isNotNull(books.deletedAt), lt(books.deletedAt, cutoff)))
      .returning({
        id: books.id,
        fileKey: books.fileKey,
        coverKey: books.coverKey,
        epubKey: books.epubKey,
        textLayerKey: books.textLayerKey,
        reflowKey: books.reflowKey,
      }),
  );
}

/** Categories of many books, keyed by book id, in a single query. */
export async function findCategoriesForBooks(
  db: Database,
  bookIds: string[],
): Promise<Map<string, CategoryDto[]>> {
  const byBook = new Map<string, CategoryDto[]>();
  if (bookIds.length === 0) {
    return byBook;
  }

  const rows = await db
    .select({
      bookId: bookCategories.bookId,
      id: categories.id,
      name: categories.name,
      color: categories.color,
    })
    .from(bookCategories)
    .innerJoin(categories, eq(categories.id, bookCategories.categoryId))
    .where(inArray(bookCategories.bookId, bookIds))
    .orderBy(asc(categories.sortOrder), asc(categories.name));

  for (const row of rows) {
    const list = byBook.get(row.bookId);
    const dto: CategoryDto = { id: row.id, name: row.name, color: row.color };
    if (list) {
      list.push(dto);
    } else {
      byBook.set(row.bookId, [dto]);
    }
  }
  return byBook;
}

/** Display names of many uploaders, keyed by user id, in a single query. */
export async function findUploaderNames(
  db: Database,
  userIds: string[],
): Promise<Map<string, string>> {
  if (userIds.length === 0) {
    return new Map();
  }
  const rows = await db
    .select({ id: users.id, displayName: users.displayName })
    .from(users)
    .where(inArray(users.id, [...new Set(userIds)]));
  return new Map(rows.map((row) => [row.id, row.displayName]));
}
