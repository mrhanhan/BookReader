import type {
  AnnotationDto,
  BookmarkDto,
  Locator,
  SyncEntityType,
  SyncOp,
} from '@bookr/shared';

/** Last known reading position of one book, owned by one user. */
export interface LocalProgressRow {
  userId: string;
  bookId: string;
  locator: Locator;
  percent: number;
  updatedAt: string;
  clientUpdatedAt: string;
  dirty: boolean;
}

/** Local annotation, mirroring the REST DTO plus sync bookkeeping. */
export interface LocalAnnotationRow extends AnnotationDto {
  userId: string;
  clientUpdatedAt: string;
  dirty: boolean;
}

/** Local bookmark, mirroring the REST DTO plus sync bookkeeping. */
export interface LocalBookmarkRow extends BookmarkDto {
  userId: string;
  clientUpdatedAt: string;
  dirty: boolean;
}

/** Reader settings are one document per user. */
export interface LocalSettingsRow {
  userId: string;
  settings: Record<string, unknown>;
  clientUpdatedAt: string;
  dirty: boolean;
}

/** One unsent mutation; rows are removed once the server confirms them. */
export interface OutboxRow {
  id: string;
  userId: string;
  entityType: SyncEntityType;
  entityId: string;
  op: SyncOp;
  payload: unknown;
  clientUpdatedAt: string;
  attempts: number;
  nextAttemptAt: number;
}

/** Generic key/value record for the sync cursor and other bookkeeping. */
export interface SyncMetaRow {
  key: string;
  value: unknown;
}

/** A book file kept on the device for offline reading. */
export interface OfflineBookRow {
  bookId: string;
  userId: string;
  pinned: boolean;
  lastReadAt: number;
  cachedAt: number;
  bytes: number;
}

/** Snapshot of the library metadata, cached for the offline shelf. */
export interface CachedShelfBook {
  id: string;
  userId: string;
  title: string;
  author: string | null;
  format: string;
  coverUrl: string | null;
  updatedAt: string;
  /** Whether a reflow pack exists, so the offline reader can offer the switch. */
  reflowAvailable: boolean;
  /**
   * Deletion instant from the last snapshot, so trashed books stay out of the
   * offline shelf. Absent on rows written before tombstones were recorded.
   */
  deletedAt?: string | null;
}
