import { BOOK_FORMATS } from '@bookr/shared';
import type { BookDto, BookFormat } from '@bookr/shared';
import type { CachedShelfBook } from '../sync/types';

/**
 * The shelf snapshot keeps only what the shelf needs to render while the
 * library API is unreachable. Reading data (progress, notes) stays in its own
 * per-user tables; this table is a shared-metadata cache.
 */
export function shelfSnapshotOf(book: BookDto, userId: string): CachedShelfBook {
  return {
    id: book.id,
    userId,
    title: book.title,
    author: book.author,
    format: book.format,
    coverUrl: book.coverUrl,
    updatedAt: book.updatedAt,
    // Kept so the offline reader can still offer the reflow switch.
    reflowAvailable: book.reflowAvailable,
    // Tombstones keep a book deleted on another device out of the offline shelf.
    deletedAt: book.deletedAt,
  };
}

function isBookFormat(value: string): value is BookFormat {
  return (BOOK_FORMATS as readonly string[]).includes(value);
}

/**
 * Rebuilds a shelf entry from the snapshot. Fields the snapshot deliberately
 * does not store (progress, categories, conversion state) fall back to neutral
 * values; the book stays readable offline with its original format.
 */
export function bookFromShelfSnapshot(row: CachedShelfBook): BookDto {
  return {
    id: row.id,
    title: row.title,
    author: row.author,
    description: null,
    format: isBookFormat(row.format) ? row.format : 'epub',
    size: 0,
    coverUrl: row.coverUrl,
    status: 'unread',
    progressPercent: 0,
    categories: [],
    uploadedBy: { id: '', displayName: '本机缓存' },
    conversionStatus: 'none',
    conversionError: null,
    // Snapshots written before this field existed read as "no pack".
    reflowAvailable: row.reflowAvailable === true,
    reflowSchemaVersion: null,
    reflowPageCount: null,
    createdAt: row.updatedAt,
    updatedAt: row.updatedAt,
    deletedAt: row.deletedAt ?? null,
  };
}
