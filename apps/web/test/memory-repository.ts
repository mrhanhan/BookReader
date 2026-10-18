import { newId, normalizeTags } from '@bookr/shared';
import type {
  AnnotationColor,
  AnnotationDto,
  BookmarkDto,
  Locator,
  SyncChangeEnvelope,
  SyncEntityType,
  SyncSnapshot,
} from '@bookr/shared';
import type { LocalRepository } from '../src/sync/repository';
import type { SyncEngine, SyncState } from '../src/sync/engine';
import type {
  LocalAnnotationRow,
  LocalBookmarkRow,
  LocalProgressRow,
  LocalSettingsRow,
  OutboxRow,
} from '../src/sync/types';

/**
 * In-memory LocalRepository used by reader tests. It mirrors the Dexie
 * repository's observable behaviour (rows, outbox entries, LWW on server
 * changes) without touching IndexedDB.
 */
export interface MemoryRepository extends LocalRepository {
  readonly outbox: OutboxRow[];
  readonly progressRows: Map<string, LocalProgressRow>;
  readonly annotationRows: Map<string, LocalAnnotationRow>;
  readonly bookmarkRows: Map<string, LocalBookmarkRow>;
  readonly settingsRows: Map<string, LocalSettingsRow>;
  seedProgress(userId: string, bookId: string, locator: Locator, at?: number): LocalProgressRow;
  seedAnnotation(
    userId: string,
    input: Omit<LocalAnnotationRow, 'userId' | 'clientUpdatedAt' | 'dirty' | 'revision' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<LocalAnnotationRow, 'clientUpdatedAt' | 'dirty' | 'id'>>,
  ): LocalAnnotationRow;
  seedBookmark(
    userId: string,
    input: Omit<LocalBookmarkRow, 'userId' | 'clientUpdatedAt' | 'dirty' | 'createdAt' | 'updatedAt'> &
      Partial<Pick<LocalBookmarkRow, 'clientUpdatedAt' | 'dirty' | 'id'>>,
  ): LocalBookmarkRow;
  clearOutbox(): void;
}

function key(userId: string, bookId: string): string {
  return `${userId}\u0000${bookId}`;
}

function iso(at?: number): string {
  return new Date(at ?? Date.now()).toISOString();
}

/** Mirrors the Dexie repository's newest-first list order. */
function newestFirst<T extends { id: string }>(timeOf: (row: T) => string): (a: T, b: T) => number {
  return (left, right) => {
    const delta = Date.parse(timeOf(right)) - Date.parse(timeOf(left));
    if (delta !== 0) {
      return delta;
    }
    if (left.id === right.id) {
      return 0;
    }
    return left.id < right.id ? 1 : -1;
  };
}

export function createMemoryRepository(): MemoryRepository {
  const progressRows = new Map<string, LocalProgressRow>();
  const annotationRows = new Map<string, LocalAnnotationRow>();
  const bookmarkRows = new Map<string, LocalBookmarkRow>();
  const settingsRows = new Map<string, LocalSettingsRow>();
  const cursors = new Map<string, number>();
  const lastSynced = new Map<string, number>();
  const outbox: OutboxRow[] = [];

  function enqueue(
    userId: string,
    entityType: SyncEntityType,
    entityId: string,
    op: 'upsert' | 'delete',
    payload: unknown,
    clientUpdatedAt: string,
  ): void {
    if (entityType === 'reading_progress' && op === 'upsert') {
      const existing = outbox.find(
        (row) =>
          row.userId === userId &&
          row.entityType === entityType &&
          row.entityId === entityId &&
          row.op === 'upsert',
      );
      if (existing !== undefined) {
        existing.payload = payload;
        existing.clientUpdatedAt = clientUpdatedAt;
        return;
      }
    }

    outbox.push({
      id: newId(),
      userId,
      entityType,
      entityId,
      op,
      payload,
      clientUpdatedAt,
      attempts: 0,
      nextAttemptAt: 0,
    });
  }

  function dropOutbox(userId: string, entityType: SyncEntityType, entityId: string): void {
    for (let index = outbox.length - 1; index >= 0; index -= 1) {
      const row = outbox[index];
      if (row?.userId === userId && row.entityType === entityType && row.entityId === entityId) {
        outbox.splice(index, 1);
      }
    }
  }

  return {
    outbox,
    progressRows,
    annotationRows,
    bookmarkRows,
    settingsRows,

    async progressFor(userId, bookId) {
      return progressRows.get(key(userId, bookId)) ?? null;
    },

    async saveProgress(userId, bookId, locator, at) {
      const clientUpdatedAt = iso(at);
      const row: LocalProgressRow = {
        userId,
        bookId,
        locator,
        percent: locator.percent,
        updatedAt: clientUpdatedAt,
        clientUpdatedAt,
        dirty: true,
      };
      progressRows.set(key(userId, bookId), row);
      enqueue(userId, 'reading_progress', bookId, 'upsert', { bookId, locator }, clientUpdatedAt);
      return row;
    },

    async importProgress(userId, bookId, locator, at) {
      const existing = progressRows.get(key(userId, bookId));
      if (existing !== undefined) {
        return existing;
      }
      const clientUpdatedAt = iso(at);
      const row: LocalProgressRow = {
        userId,
        bookId,
        locator,
        percent: locator.percent,
        updatedAt: clientUpdatedAt,
        clientUpdatedAt,
        dirty: false,
      };
      progressRows.set(key(userId, bookId), row);
      return row;
    },

    async listAnnotations(userId, bookId) {
      return [...annotationRows.values()]
        .filter((row) => row.userId === userId && row.bookId === bookId)
        .sort(newestFirst((row) => row.updatedAt));
    },

    async createAnnotation(userId, input) {
      const clientUpdatedAt = iso();
      const row: LocalAnnotationRow = {
        id: newId(),
        bookId: input.bookId,
        type: input.type,
        color: input.color,
        locator: input.locator,
        selectedText: input.selectedText,
        noteText: input.noteText,
        tags: normalizeTags(input.tags),
        revision: 1,
        createdAt: clientUpdatedAt,
        updatedAt: clientUpdatedAt,
        userId,
        clientUpdatedAt,
        dirty: true,
      };
      annotationRows.set(row.id, row);
      enqueue(
        userId,
        'annotation',
        row.id,
        'upsert',
        {
          bookId: row.bookId,
          type: row.type,
          color: row.color,
          locator: row.locator,
          selectedText: row.selectedText,
          noteText: row.noteText,
          tags: row.tags,
        },
        clientUpdatedAt,
      );
      return row;
    },

    async updateAnnotation(userId, bookId, id, patch) {
      const existing = annotationRows.get(id);
      if (!existing || existing.userId !== userId || existing.bookId !== bookId) {
        return null;
      }
      const clientUpdatedAt = iso();
      const updated: LocalAnnotationRow = {
        ...existing,
        color: patch.color ?? existing.color,
        noteText: patch.noteText === undefined ? existing.noteText : patch.noteText,
        tags: patch.tags === undefined ? existing.tags : normalizeTags(patch.tags),
        revision: existing.revision + 1,
        updatedAt: clientUpdatedAt,
        clientUpdatedAt,
        dirty: true,
      };
      annotationRows.set(id, updated);
      enqueue(
        userId,
        'annotation',
        id,
        'upsert',
        {
          bookId: updated.bookId,
          type: updated.type,
          color: updated.color,
          locator: updated.locator,
          selectedText: updated.selectedText,
          noteText: updated.noteText,
          tags: updated.tags,
        },
        clientUpdatedAt,
      );
      return updated;
    },

    async deleteAnnotation(userId, bookId, id) {
      const existing = annotationRows.get(id);
      if (!existing || existing.userId !== userId || existing.bookId !== bookId) {
        return;
      }
      const clientUpdatedAt = iso();
      annotationRows.delete(id);
      enqueue(userId, 'annotation', id, 'delete', undefined, clientUpdatedAt);
    },

    async listBookmarks(userId, bookId) {
      return [...bookmarkRows.values()]
        .filter((row) => row.userId === userId && row.bookId === bookId)
        .sort(newestFirst((row) => row.createdAt));
    },

    async createBookmark(userId, input) {
      const clientUpdatedAt = iso();
      const row: LocalBookmarkRow = {
        id: newId(),
        bookId: input.bookId,
        locator: input.locator,
        label: input.label,
        createdAt: clientUpdatedAt,
        updatedAt: clientUpdatedAt,
        userId,
        clientUpdatedAt,
        dirty: true,
      };
      bookmarkRows.set(row.id, row);
      enqueue(
        userId,
        'bookmark',
        row.id,
        'upsert',
        { bookId: row.bookId, locator: row.locator, label: row.label },
        clientUpdatedAt,
      );
      return row;
    },

    async updateBookmark(userId, bookId, id, label) {
      const existing = bookmarkRows.get(id);
      if (!existing || existing.userId !== userId || existing.bookId !== bookId) {
        return null;
      }
      const clientUpdatedAt = iso();
      const updated: LocalBookmarkRow = {
        ...existing,
        label,
        updatedAt: clientUpdatedAt,
        clientUpdatedAt,
        dirty: true,
      };
      bookmarkRows.set(id, updated);
      enqueue(
        userId,
        'bookmark',
        id,
        'upsert',
        { bookId: updated.bookId, locator: updated.locator, label: updated.label },
        clientUpdatedAt,
      );
      return updated;
    },

    async deleteBookmark(userId, bookId, id) {
      const existing = bookmarkRows.get(id);
      if (!existing || existing.userId !== userId || existing.bookId !== bookId) {
        return;
      }
      const clientUpdatedAt = iso();
      bookmarkRows.delete(id);
      enqueue(userId, 'bookmark', id, 'delete', undefined, clientUpdatedAt);
    },

    async settingsFor(userId) {
      return settingsRows.get(userId) ?? null;
    },

    async saveSettings(userId, settings) {
      const clientUpdatedAt = iso();
      settingsRows.set(userId, { userId, settings, clientUpdatedAt, dirty: true });
      enqueue(userId, 'reader_settings', userId, 'upsert', { settings }, clientUpdatedAt);
    },

    async pendingCount(userId) {
      return outbox.filter((row) => row.userId === userId).length;
    },

    async hasPending(userId, entityType, entityId) {
      return outbox.some(
        (row) =>
          row.userId === userId && row.entityType === entityType && row.entityId === entityId,
      );
    },

    async applyServerChange(userId, change) {
      if (change.op === 'delete') {
        if (change.entityType === 'annotation') annotationRows.delete(change.entityId);
        if (change.entityType === 'bookmark') bookmarkRows.delete(change.entityId);
        dropOutbox(userId, change.entityType, change.entityId);
        return 'applied';
      }

      const payload = (change.payload ?? {}) as Record<string, unknown>;
      if (change.entityType === 'reading_progress') {
        const bookId = String(payload['bookId'] ?? change.entityId);
        const locator = payload['locator'] as Locator;
        progressRows.set(key(userId, bookId), {
          userId,
          bookId,
          locator,
          percent: typeof payload['percent'] === 'number' ? payload['percent'] : locator.percent,
          updatedAt: String(payload['updatedAt'] ?? change.serverUpdatedAt),
          clientUpdatedAt: String(payload['clientUpdatedAt'] ?? change.clientUpdatedAt),
          dirty: false,
        });
      } else if (change.entityType === 'annotation') {
        annotationRows.set(change.entityId, {
          ...(payload as unknown as LocalAnnotationRow),
          userId,
          clientUpdatedAt: String(payload['clientUpdatedAt'] ?? change.clientUpdatedAt),
          dirty: false,
        });
      } else if (change.entityType === 'bookmark') {
        bookmarkRows.set(change.entityId, {
          ...(payload as unknown as LocalBookmarkRow),
          userId,
          clientUpdatedAt: String(payload['clientUpdatedAt'] ?? change.clientUpdatedAt),
          dirty: false,
        });
      } else {
        const settings = (payload['settings'] ?? {}) as Record<string, unknown>;
        settingsRows.set(userId, {
          userId,
          settings,
          clientUpdatedAt: String(payload['clientUpdatedAt'] ?? change.clientUpdatedAt),
          dirty: false,
        });
      }
      dropOutbox(userId, change.entityType, change.entityId);
      return 'applied';
    },

    async applySnapshot(userId: string, snapshot: SyncSnapshot) {
      for (const [rowKey, row] of progressRows) {
        if (row.userId === userId) progressRows.delete(rowKey);
      }
      for (const [id, row] of annotationRows) {
        if (row.userId === userId) annotationRows.delete(id);
      }
      for (const [id, row] of bookmarkRows) {
        if (row.userId === userId) bookmarkRows.delete(id);
      }
      settingsRows.delete(userId);

      for (const entry of snapshot.progress) {
        const payload = entry as Record<string, unknown>;
        const locator = payload['locator'] as Locator;
        const bookId = String(payload['bookId']);
        progressRows.set(key(userId, bookId), {
          userId,
          bookId,
          locator,
          percent: typeof payload['percent'] === 'number' ? payload['percent'] : locator.percent,
          updatedAt: String(payload['updatedAt']),
          clientUpdatedAt: String(payload['clientUpdatedAt']),
          dirty: false,
        });
      }
      for (const entry of snapshot.annotations) {
        const payload = entry as unknown as LocalAnnotationRow;
        annotationRows.set(payload.id, { ...payload, userId, dirty: false });
      }
      for (const entry of snapshot.bookmarks) {
        const payload = entry as unknown as LocalBookmarkRow;
        bookmarkRows.set(payload.id, { ...payload, userId, dirty: false });
      }
      if (snapshot.settings !== null) {
        const payload = snapshot.settings as Record<string, unknown>;
        settingsRows.set(userId, {
          userId,
          settings: (payload['settings'] ?? {}) as Record<string, unknown>,
          clientUpdatedAt: String(payload['clientUpdatedAt']),
          dirty: false,
        });
      }
    },

    async getCursor(userId) {
      return cursors.get(userId) ?? 0;
    },

    async setCursor(userId, cursor) {
      cursors.set(userId, cursor);
    },

    async getLastSyncedAt(userId) {
      return lastSynced.get(userId) ?? null;
    },

    async setLastSyncedAt(userId, at) {
      lastSynced.set(userId, at);
    },

    seedProgress(userId, bookId, locator, at) {
      const clientUpdatedAt = iso(at);
      const row: LocalProgressRow = {
        userId,
        bookId,
        locator,
        percent: locator.percent,
        updatedAt: clientUpdatedAt,
        clientUpdatedAt,
        dirty: false,
      };
      progressRows.set(key(userId, bookId), row);
      return row;
    },

    seedAnnotation(userId, input) {
      const clientUpdatedAt = input.clientUpdatedAt ?? iso();
      const row: LocalAnnotationRow = {
        id: input.id ?? newId(),
        bookId: input.bookId,
        type: input.type,
        color: input.color as AnnotationColor,
        locator: input.locator,
        selectedText: input.selectedText,
        noteText: input.noteText,
        tags: input.tags,
        revision: 1,
        createdAt: clientUpdatedAt,
        updatedAt: clientUpdatedAt,
        userId,
        clientUpdatedAt,
        dirty: input.dirty ?? false,
      };
      annotationRows.set(row.id, row);
      return row;
    },

    seedBookmark(userId, input) {
      const clientUpdatedAt = input.clientUpdatedAt ?? iso();
      const row: LocalBookmarkRow = {
        id: input.id ?? newId(),
        bookId: input.bookId,
        locator: input.locator,
        label: input.label,
        createdAt: clientUpdatedAt,
        updatedAt: clientUpdatedAt,
        userId,
        clientUpdatedAt,
        dirty: input.dirty ?? false,
      };
      bookmarkRows.set(row.id, row);
      return row;
    },

    clearOutbox() {
      outbox.length = 0;
    },
  };
}

/** Minimal engine used by reader tests; state can be pushed from a test. */
export interface FakeSyncEngine extends SyncEngine {
  /** Reasons passed to `syncNow`, in call order. */
  readonly syncNowCalls: string[];
  setState(next: SyncState): void;
}

export function createFakeSyncEngine(initial?: Partial<SyncState>): FakeSyncEngine {
  let listener: ((state: SyncState) => void) | null = null;
  const syncNowCalls: string[] = [];
  let state: SyncState = {
    status: 'synced',
    pending: 0,
    lastSyncedAt: null,
    conflicts: 0,
    ...initial,
  };

  return {
    syncNowCalls,
    start() {
      listener?.(state);
    },
    async stop() {},
    async syncNow(reason?: string) {
      syncNowCalls.push(reason ?? '');
    },
    getState() {
      return { ...state };
    },
    subscribe(next) {
      listener = next;
      next(state);
      return () => {
        if (listener === next) listener = null;
      };
    },
    setState(next) {
      state = next;
      listener?.(next);
    },
  };
}
