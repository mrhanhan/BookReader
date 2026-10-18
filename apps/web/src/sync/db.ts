import Dexie, { type Table } from 'dexie';
import type {
  CachedShelfBook,
  LocalAnnotationRow,
  LocalBookmarkRow,
  LocalProgressRow,
  LocalSettingsRow,
  OfflineBookRow,
  OutboxRow,
  SyncMetaRow,
} from './types';

/**
 * IndexedDB schema shared by the reader, the settings page and the sync engine.
 *
 * `progress` is keyed by the compound `[userId+bookId]`: one row per user and book.
 * Dexie treats the first entry of a store declaration as the primary key, so the
 * compound key must lead the list rather than sit in index position as in the plan.
 */
export class BookrDb extends Dexie {
  progress!: Table<LocalProgressRow, [string, string]>;
  annotations!: Table<LocalAnnotationRow, string>;
  bookmarks!: Table<LocalBookmarkRow, string>;
  settings!: Table<LocalSettingsRow, string>;
  outbox!: Table<OutboxRow, string>;
  meta!: Table<SyncMetaRow, string>;
  offlineBooks!: Table<OfflineBookRow, string>;
  shelf!: Table<CachedShelfBook, string>;

  constructor(name = 'bookr-sync') {
    super(name);
    this.version(1).stores({
      progress: '[userId+bookId], userId, bookId, updatedAt',
      annotations: 'id, userId, bookId, [userId+bookId], dirty',
      bookmarks: 'id, userId, bookId, [userId+bookId], dirty',
      settings: 'userId',
      outbox: 'id, userId, [userId+nextAttemptAt]',
      meta: 'key',
      offlineBooks: 'bookId, userId, pinned, lastReadAt',
      shelf: 'id, userId, updatedAt',
    });
  }
}

/** Opens the local database; tests pass a unique name per case. */
export function createSyncDb(name?: string): BookrDb {
  return new BookrDb(name);
}
