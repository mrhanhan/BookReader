import Dexie, { type Table } from 'dexie';
import type {
  CachedShelfBook,
  LocalAnnotationRow,
  LocalBookmarkRow,
  LocalProgressRow,
  LocalReadingSessionRow,
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
  offlineBooks!: Table<OfflineBookRow, [string, string]>;
  shelf!: Table<CachedShelfBook, [string, string]>;
  readingSessions!: Table<LocalReadingSessionRow, string>;

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

    // Cache rows became per-user: the same book may be pinned for one account
    // and evicted for another on a shared device. Dexie cannot change a primary
    // key in place, so version 2 drops the table (cache rows are rebuildable)
    // and version 3 recreates it with the compound key.
    this.version(2).stores({
      offlineBooks: null,
    });
    this.version(3).stores({
      offlineBooks: '[userId+bookId], userId, bookId, pinned, lastReadAt',
    });

    // Shelf snapshots became per-user too: on a shared browser one account's
    // cached metadata must not overwrite another's. Same two-step dance as
    // above because Dexie cannot change a primary key in place; snapshots are
    // rebuildable, so version 4 drops the table and version 5 recreates it.
    this.version(4).stores({
      shelf: null,
    });
    this.version(5).stores({
      shelf: '[userId+id], userId, id',
    });

    // Reading sessions are local-first: one row per segment, updated in place
    // by heartbeats and retained as this device's own history once the server
    // acknowledges it.
    this.version(6).stores({
      readingSessions: 'id, userId, bookId, startedAt',
    });
  }
}

/** Opens the local database; tests pass a unique name per case. */
export function createSyncDb(name?: string): BookrDb {
  return new BookrDb(name);
}
