import type { BookFormat } from '@bookr/shared';
import { and, asc, eq, isNotNull, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { books } from '../db/schema';
import { storeCover } from './metadata';

/** What one backfill run did. */
export interface CoverBackfillResult {
  scanned: number;
  updated: number;
  failed: number;
}

/** Logs the book id and error class only; parser messages may contain book text. */
function logBackfillFailure(bookId: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : typeof error;
  console.error(`[cover-backfill] book ${bookId} failed with ${errorName}`);
}

/**
 * Extracts covers for live books that still have none. Per-book failures are
 * counted and logged but never abort the run, and a concurrent cover upload
 * (or another backfill) wins because the update only touches rows whose
 * `cover_key` is still null. `refreshExisting` re-extracts books that already
 * have a cover (for example a blank first page captured before this fix).
 */
export async function backfillMissingCovers(
  deps: AppDeps,
  options: { limit?: number; refreshExisting?: boolean } = {},
): Promise<CoverBackfillResult> {
  const conditions = [isNull(books.deletedAt), isNotNull(books.fileKey)];
  if (!options.refreshExisting) {
    conditions.push(isNull(books.coverKey));
  }
  const query = deps.db
    .select()
    .from(books)
    .where(and(...conditions))
    .orderBy(asc(books.createdAt));
  const rows = options.limit !== undefined ? await query.limit(options.limit) : await query;

  let scanned = 0;
  let updated = 0;
  let failed = 0;

  for (const book of rows) {
    scanned += 1;

    // A converted MOBI/AZW3 keeps its original format but its EPUB is the
    // best cover source, mirroring `runMetadataJob`.
    const sourceKey = book.epubKey ?? book.fileKey;
    if (!sourceKey) {
      continue;
    }
    const format: BookFormat = book.epubKey ? 'epub' : book.format;

    try {
      const buffer = await deps.storage.getObject(sourceKey);
      const extracted = await deps.metadataRunner.extract({ buffer, format });

      if (extracted.coverError !== undefined) {
        failed += 1;
        logBackfillFailure(book.id, extracted.coverError);
        continue;
      }
      // Formats without an extractor (MOBI/AZW3 without a converted EPUB)
      // legitimately have no cover; they are scanned but not failed.
      if (!extracted.cover) {
        continue;
      }

      const coverKey = await storeCover(deps, book.id, extracted.cover);
      if (!coverKey) {
        failed += 1;
        continue;
      }

      const claim = options.refreshExisting
        ? and(eq(books.id, book.id), isNull(books.deletedAt))
        : and(eq(books.id, book.id), isNull(books.coverKey), isNull(books.deletedAt));
      const claimed = await deps.db
        .update(books)
        .set({ coverKey, updatedAt: deps.clock.now() })
        .where(claim)
        .returning({ id: books.id });
      if (claimed.length > 0) {
        updated += 1;
      }
    } catch (error) {
      failed += 1;
      logBackfillFailure(book.id, error);
    }
  }

  return { scanned, updated, failed };
}
