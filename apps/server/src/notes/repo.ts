import {
  ERROR_CODES,
  NOTE_TAG_LIMIT,
  type BookFormat,
  type NoteFilters,
  type NoteTagCount,
} from '@bookr/shared';
import { and, asc, desc, eq, isNull, or, sql, type SQL } from 'drizzle-orm';
import type { Database } from '../db/client';
import { annotations, books, users, type AnnotationRow } from '../db/schema';
import { AppError } from '../errors';

/** One note joined with the book metadata the library needs to show it. */
export interface NoteQueryRow {
  annotation: AnnotationRow;
  book: { id: string; title: string; author: string | null; format: BookFormat };
}

const bookColumns = {
  id: books.id,
  title: books.title,
  author: books.author,
  format: books.format,
};

/**
 * Builds the shared visibility and filter predicate. Every query starts from
 * the caller's own live notes on live books; filters only narrow that set.
 */
function noteConditions(userId: string, timezone: string, filters: NoteFilters): SQL[] {
  const conditions: SQL[] = [
    eq(annotations.userId, userId),
    isNull(annotations.deletedAt),
    isNull(books.deletedAt),
  ];

  const text = filters.q?.trim();
  if (text) {
    // strpos compares raw substrings, so `%` and `_` are literal characters.
    conditions.push(
      or(
        sql`strpos(lower(${annotations.selectedText}), lower(${text})) > 0`,
        sql`strpos(lower(coalesce(${annotations.noteText}, '')), lower(${text})) > 0`,
      )!,
    );
  }

  if (filters.tag) {
    conditions.push(sql`${annotations.tags} @> ARRAY[${filters.tag}]::text[]`);
  }

  if (filters.bookId) {
    conditions.push(eq(books.id, filters.bookId));
  }

  if (filters.type) {
    conditions.push(eq(annotations.type, filters.type));
  }

  if (filters.from) {
    conditions.push(
      sql`(${annotations.updatedAt} AT TIME ZONE ${timezone})::date >= ${filters.from}::date`,
    );
  }

  if (filters.to) {
    conditions.push(
      sql`(${annotations.updatedAt} AT TIME ZONE ${timezone})::date <= ${filters.to}::date`,
    );
  }

  return conditions;
}

/** Counts the notes matching a predicate, sharing it with the row query. */
async function countNotes(db: Database, where: SQL | undefined): Promise<number> {
  const [counted] = await db
    .select({ total: sql<number>`count(*)::int` })
    .from(annotations)
    .innerJoin(books, eq(books.id, annotations.bookId))
    .where(where);
  return Number(counted?.total ?? 0);
}

/** Selects joined note rows ordered by the caller's sort columns. */
async function selectNoteRows(
  db: Database,
  where: SQL | undefined,
  orderBy: SQL[],
  limit: number,
  offset: number,
): Promise<NoteQueryRow[]> {
  return db
    .select({ annotation: annotations, book: bookColumns })
    .from(annotations)
    .innerJoin(books, eq(books.id, annotations.bookId))
    .where(where)
    .orderBy(...orderBy)
    .limit(limit)
    .offset(offset);
}

/** One page of the notes library, most recently edited first. */
export async function listNotePage(
  db: Database,
  input: { userId: string; timezone: string; filters: NoteFilters; page: number; pageSize: number },
): Promise<{ rows: NoteQueryRow[]; total: number }> {
  const where = and(...noteConditions(input.userId, input.timezone, input.filters));
  const total = await countNotes(db, where);
  const rows = await selectNoteRows(
    db,
    where,
    [desc(annotations.updatedAt), desc(annotations.id)],
    input.pageSize,
    (input.page - 1) * input.pageSize,
  );
  return { rows, total };
}

/** Rows for a Markdown export, grouped by book title then note creation time. */
export async function listNotesForExport(
  db: Database,
  input: { userId: string; timezone: string; filters: NoteFilters; limit: number },
): Promise<{ rows: NoteQueryRow[]; total: number }> {
  const where = and(...noteConditions(input.userId, input.timezone, input.filters));
  const total = await countNotes(db, where);
  const rows = await selectNoteRows(
    db,
    where,
    [asc(books.title), asc(annotations.createdAt), asc(annotations.id)],
    input.limit,
    0,
  );
  return { rows, total };
}

/** Rows for AI analysis: the newest edits first, capped by the caller. */
export async function listNotesForAnalysis(
  db: Database,
  input: { userId: string; timezone: string; filters: NoteFilters; limit: number },
): Promise<{ rows: NoteQueryRow[]; total: number }> {
  const where = and(...noteConditions(input.userId, input.timezone, input.filters));
  const total = await countNotes(db, where);
  const rows = await selectNoteRows(
    db,
    where,
    [desc(annotations.updatedAt), desc(annotations.id)],
    input.limit,
    0,
  );
  return { rows, total };
}

/**
 * Distinct tags on the caller's visible notes, most used first. Ties are
 * broken by tag text so repeated requests keep the same order.
 */
export async function listNoteTagCounts(db: Database, userId: string): Promise<NoteTagCount[]> {
  const result = await db.execute<{ tag: string; count: number }>(sql`
    select tag.tag as "tag", count(*)::int as "count"
    from ${annotations}
    inner join ${books} on ${books.id} = ${annotations.bookId}
    cross join lateral unnest(${annotations.tags}) as tag(tag)
    where ${annotations.userId} = ${userId}
      and ${annotations.deletedAt} is null
      and ${books.deletedAt} is null
    group by tag.tag
    order by count(*) desc, tag.tag asc
    limit ${NOTE_TAG_LIMIT}
  `);
  return result.rows.map((row) => ({ tag: row.tag, count: Number(row.count) }));
}

/** Reads a user's IANA timezone; a missing account is a 404. */
export async function loadUserTimezone(db: Database, userId: string): Promise<string> {
  const [user] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return user.timezone;
}

/** Title of a live book, used to name a single-book export. */
export async function findLiveBookTitle(
  db: Database,
  bookId: string,
): Promise<string | null> {
  const [book] = await db
    .select({ title: books.title })
    .from(books)
    .where(and(eq(books.id, bookId), isNull(books.deletedAt)))
    .limit(1);
  return book?.title ?? null;
}
