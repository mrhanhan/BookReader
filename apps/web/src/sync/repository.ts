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
import type { BookrDb } from './db';
import { dropOutboxFor, enqueue } from './outbox';
import type {
  LocalAnnotationRow,
  LocalBookmarkRow,
  LocalProgressRow,
  LocalSettingsRow,
  OutboxRow,
} from './types';

const CURSOR_PREFIX = 'cursor:';
const LAST_SYNCED_PREFIX = 'lastSyncedAt:';

export interface LocalRepository {
  progressFor(userId: string, bookId: string): Promise<LocalProgressRow | null>;
  saveProgress(
    userId: string,
    bookId: string,
    locator: Locator,
    at?: number,
  ): Promise<LocalProgressRow>;
  listAnnotations(userId: string, bookId: string): Promise<LocalAnnotationRow[]>;
  createAnnotation(
    userId: string,
    input: {
      bookId: string;
      type: 'highlight' | 'note';
      color: AnnotationColor;
      locator: Locator;
      selectedText: string;
      noteText: string | null;
      tags: string[];
    },
  ): Promise<LocalAnnotationRow>;
  updateAnnotation(
    userId: string,
    bookId: string,
    id: string,
    patch: { color?: AnnotationColor; noteText?: string | null; tags?: string[] },
  ): Promise<LocalAnnotationRow | null>;
  deleteAnnotation(userId: string, bookId: string, id: string): Promise<void>;
  listBookmarks(userId: string, bookId: string): Promise<LocalBookmarkRow[]>;
  createBookmark(
    userId: string,
    input: { bookId: string; locator: Locator; label: string | null },
  ): Promise<LocalBookmarkRow>;
  updateBookmark(
    userId: string,
    bookId: string,
    id: string,
    label: string | null,
  ): Promise<LocalBookmarkRow | null>;
  deleteBookmark(userId: string, bookId: string, id: string): Promise<void>;
  settingsFor(userId: string): Promise<LocalSettingsRow | null>;
  saveSettings(userId: string, settings: Record<string, unknown>): Promise<void>;
  pendingCount(userId: string): Promise<number>;
  /**
   * Applies one envelope from the change log. `force` skips the last-write-wins
   * comparison and is reserved for push echoes: the server may clamp a client
   * clock that runs ahead, so the echo must overwrite the local row regardless.
   */
  applyServerChange(
    userId: string,
    change: SyncChangeEnvelope,
    options?: { force?: boolean },
  ): Promise<'applied' | 'skipped'>;
  applySnapshot(userId: string, snapshot: SyncSnapshot): Promise<void>;
  getCursor(userId: string): Promise<number>;
  setCursor(userId: string, cursor: number): Promise<void>;
  getLastSyncedAt(userId: string): Promise<number | null>;
  setLastSyncedAt(userId: string, at: number): Promise<void>;
}

/** Shapes written to the change log: the full object, not just the write fields. */
interface ProgressPayload {
  bookId: string;
  locator: Locator;
  percent: number;
  updatedAt: string;
  clientUpdatedAt: string;
}

interface AnnotationPayload extends AnnotationDto {
  clientUpdatedAt: string;
}

interface BookmarkPayload extends BookmarkDto {
  clientUpdatedAt: string;
}

interface SettingsPayload {
  settings: Record<string, unknown>;
  clientUpdatedAt: string;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null;
}

function isLocator(value: unknown): value is Locator {
  if (!isRecord(value)) {
    return false;
  }

  const kind = value['kind'];
  return kind === 'pdf' || kind === 'epub' || kind === 'reflow';
}

function readStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) {
    return null;
  }

  return value.every((item): item is string => typeof item === 'string') ? (value as string[]) : null;
}

/** Payload as returned by the change log or the snapshot. */
function readProgressPayload(value: unknown): ProgressPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const bookId = value['bookId'];
  const locator = value['locator'];
  if (typeof bookId !== 'string' || !isLocator(locator)) {
    return null;
  }

  const updatedAt = typeof value['updatedAt'] === 'string' ? value['updatedAt'] : null;
  const clientUpdatedAt =
    typeof value['clientUpdatedAt'] === 'string' ? value['clientUpdatedAt'] : updatedAt;
  if (updatedAt === null || clientUpdatedAt === null) {
    return null;
  }

  return {
    bookId,
    locator,
    percent: typeof value['percent'] === 'number' ? value['percent'] : locator.percent,
    updatedAt,
    clientUpdatedAt,
  };
}

function readAnnotationPayload(value: unknown): AnnotationPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value['id'];
  const bookId = value['bookId'];
  const type = value['type'];
  const color = value['color'];
  const locator = value['locator'];
  const selectedText = value['selectedText'];
  const noteText = value['noteText'];
  const tags = readStringArray(value['tags']);
  const revision = value['revision'];
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  if (
    typeof id !== 'string' ||
    typeof bookId !== 'string' ||
    (type !== 'highlight' && type !== 'note') ||
    typeof color !== 'string' ||
    !isLocator(locator) ||
    typeof selectedText !== 'string' ||
    (noteText !== null && typeof noteText !== 'string') ||
    tags === null ||
    typeof revision !== 'number' ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    id,
    bookId,
    type,
    color: color as AnnotationColor,
    locator,
    selectedText,
    noteText,
    tags,
    revision,
    createdAt,
    updatedAt,
    clientUpdatedAt:
      typeof value['clientUpdatedAt'] === 'string' ? value['clientUpdatedAt'] : updatedAt,
  };
}

function readBookmarkPayload(value: unknown): BookmarkPayload | null {
  if (!isRecord(value)) {
    return null;
  }

  const id = value['id'];
  const bookId = value['bookId'];
  const locator = value['locator'];
  const label = value['label'];
  const createdAt = value['createdAt'];
  const updatedAt = value['updatedAt'];
  if (
    typeof id !== 'string' ||
    typeof bookId !== 'string' ||
    !isLocator(locator) ||
    (label !== null && typeof label !== 'string') ||
    typeof createdAt !== 'string' ||
    typeof updatedAt !== 'string'
  ) {
    return null;
  }

  return {
    id,
    bookId,
    locator,
    label,
    createdAt,
    updatedAt,
    clientUpdatedAt:
      typeof value['clientUpdatedAt'] === 'string' ? value['clientUpdatedAt'] : updatedAt,
  };
}

function readSettingsPayload(value: unknown): SettingsPayload | null {
  if (!isRecord(value) || !isRecord(value['settings'])) {
    return null;
  }

  const updatedAt = typeof value['updatedAt'] === 'string' ? value['updatedAt'] : null;
  const clientUpdatedAt =
    typeof value['clientUpdatedAt'] === 'string' ? value['clientUpdatedAt'] : updatedAt;
  if (clientUpdatedAt === null) {
    return null;
  }

  return { settings: value['settings'], clientUpdatedAt };
}

/** Blank bookmark labels are stored as null, matching the REST endpoint. */
function normalizeBookmarkLabel(label: string | null): string | null {
  if (label === null) {
    return null;
  }

  const trimmed = label.trim();
  return trimmed === '' ? null : trimmed;
}

function clientTimeOf(at?: number): string {
  return new Date(at ?? Date.now()).toISOString();
}

function parseTime(value: string): number {
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? 0 : parsed;
}

function annotationWritePayload(row: AnnotationDto): Record<string, unknown> {
  return {
    bookId: row.bookId,
    type: row.type,
    color: row.color,
    locator: row.locator,
    selectedText: row.selectedText,
    noteText: row.noteText,
    tags: row.tags,
  };
}

function bookmarkWritePayload(row: BookmarkDto): Record<string, unknown> {
  return { bookId: row.bookId, locator: row.locator, label: row.label };
}

async function metaNumber(db: BookrDb, key: string): Promise<number | null> {
  const row = await db.meta.get(key);
  return typeof row?.value === 'number' ? row.value : null;
}

async function pendingFor(
  db: BookrDb,
  userId: string,
  entityType: SyncEntityType,
  entityId: string,
): Promise<OutboxRow[]> {
  return db.outbox
    .where('userId')
    .equals(userId)
    .filter((row) => row.entityType === entityType && row.entityId === entityId)
    .toArray();
}

/**
 * Last-write-wins gate: the server wins when it is at least as new as the newest
 * local mutation, so the echo of our own pushed change is applied and the outbox
 * entry that produced it is dropped.
 */
function serverWins(
  pending: OutboxRow[],
  localClientUpdatedAt: string | undefined,
  serverClientUpdatedAt: string,
): boolean {
  if (pending.length === 0) {
    return true;
  }

  let localTime = localClientUpdatedAt;
  for (const row of pending) {
    if (localTime === undefined || parseTime(row.clientUpdatedAt) > parseTime(localTime)) {
      localTime = row.clientUpdatedAt;
    }
  }

  return localTime === undefined || parseTime(serverClientUpdatedAt) >= parseTime(localTime);
}

async function applyProgressChange(
  db: BookrDb,
  userId: string,
  change: SyncChangeEnvelope,
  force: boolean,
): Promise<'applied' | 'skipped'> {
  return db.transaction('rw', db.progress, db.outbox, async () => {
    const local = await db.progress.get([userId, change.entityId]);
    const pending = force ? [] : await pendingFor(db, userId, 'reading_progress', change.entityId);
    if (!serverWins(pending, local?.clientUpdatedAt, change.clientUpdatedAt)) {
      return 'skipped';
    }

    if (change.op === 'delete') {
      await db.progress.delete([userId, change.entityId]);
      await dropOutboxFor(db, userId, 'reading_progress', change.entityId);
      return 'applied';
    }

    const payload = readProgressPayload(change.payload);
    if (payload === null) {
      return 'skipped';
    }

    await db.progress.put({
      userId,
      bookId: payload.bookId,
      locator: payload.locator,
      percent: payload.percent,
      updatedAt: payload.updatedAt,
      clientUpdatedAt: payload.clientUpdatedAt,
      dirty: false,
    });
    await dropOutboxFor(db, userId, 'reading_progress', change.entityId);
    return 'applied';
  });
}

async function applyAnnotationChange(
  db: BookrDb,
  userId: string,
  change: SyncChangeEnvelope,
  force: boolean,
): Promise<'applied' | 'skipped'> {
  return db.transaction('rw', db.annotations, db.outbox, async () => {
    const local = await db.annotations.get(change.entityId);
    if (local !== undefined && local.userId !== userId) {
      return 'skipped';
    }

    const pending = force ? [] : await pendingFor(db, userId, 'annotation', change.entityId);
    if (!serverWins(pending, local?.clientUpdatedAt, change.clientUpdatedAt)) {
      return 'skipped';
    }

    if (change.op === 'delete') {
      await db.annotations.delete(change.entityId);
      await dropOutboxFor(db, userId, 'annotation', change.entityId);
      return 'applied';
    }

    const payload = readAnnotationPayload(change.payload);
    if (payload === null) {
      return 'skipped';
    }

    await db.annotations.put({ ...payload, userId, dirty: false });
    await dropOutboxFor(db, userId, 'annotation', change.entityId);
    return 'applied';
  });
}

async function applyBookmarkChange(
  db: BookrDb,
  userId: string,
  change: SyncChangeEnvelope,
  force: boolean,
): Promise<'applied' | 'skipped'> {
  return db.transaction('rw', db.bookmarks, db.outbox, async () => {
    const local = await db.bookmarks.get(change.entityId);
    if (local !== undefined && local.userId !== userId) {
      return 'skipped';
    }

    const pending = force ? [] : await pendingFor(db, userId, 'bookmark', change.entityId);
    if (!serverWins(pending, local?.clientUpdatedAt, change.clientUpdatedAt)) {
      return 'skipped';
    }

    if (change.op === 'delete') {
      await db.bookmarks.delete(change.entityId);
      await dropOutboxFor(db, userId, 'bookmark', change.entityId);
      return 'applied';
    }

    const payload = readBookmarkPayload(change.payload);
    if (payload === null) {
      return 'skipped';
    }

    await db.bookmarks.put({ ...payload, userId, dirty: false });
    await dropOutboxFor(db, userId, 'bookmark', change.entityId);
    return 'applied';
  });
}

async function applySettingsChange(
  db: BookrDb,
  userId: string,
  change: SyncChangeEnvelope,
  force: boolean,
): Promise<'applied' | 'skipped'> {
  return db.transaction('rw', db.settings, db.outbox, async () => {
    const local = await db.settings.get(userId);
    const pending = force ? [] : await pendingFor(db, userId, 'reader_settings', change.entityId);
    if (!serverWins(pending, local?.clientUpdatedAt, change.clientUpdatedAt)) {
      return 'skipped';
    }

    if (change.op === 'delete') {
      await db.settings.delete(userId);
      await dropOutboxFor(db, userId, 'reader_settings', change.entityId);
      return 'applied';
    }

    const payload = readSettingsPayload(change.payload);
    if (payload === null) {
      return 'skipped';
    }

    await db.settings.put({
      userId,
      settings: payload.settings,
      clientUpdatedAt: payload.clientUpdatedAt,
      dirty: false,
    });
    await dropOutboxFor(db, userId, 'reader_settings', change.entityId);
    return 'applied';
  });
}

/** Local-first store used by the reader, the settings page and the sync engine. */
export function createRepository(db: BookrDb): LocalRepository {
  return {
    async progressFor(userId, bookId) {
      return (await db.progress.get([userId, bookId])) ?? null;
    },

    async saveProgress(userId, bookId, locator, at) {
      const clientUpdatedAt = clientTimeOf(at);
      return db.transaction('rw', db.progress, db.outbox, async () => {
        const row: LocalProgressRow = {
          userId,
          bookId,
          locator,
          percent: locator.percent,
          updatedAt: clientUpdatedAt,
          clientUpdatedAt,
          dirty: true,
        };
        await db.progress.put(row);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'reading_progress',
          entityId: bookId,
          op: 'upsert',
          payload: { bookId, locator },
          clientUpdatedAt,
        });
        return row;
      });
    },

    async listAnnotations(userId, bookId) {
      return db.annotations.where('[userId+bookId]').equals([userId, bookId]).toArray();
    },

    async createAnnotation(userId, input) {
      const clientUpdatedAt = clientTimeOf();
      const id = newId();
      const row: LocalAnnotationRow = {
        id,
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
      await db.transaction('rw', db.annotations, db.outbox, async () => {
        await db.annotations.put(row);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'annotation',
          entityId: row.id,
          op: 'upsert',
          payload: annotationWritePayload(row),
          clientUpdatedAt,
        });
      });
      return row;
    },

    async updateAnnotation(userId, bookId, id, patch) {
      const clientUpdatedAt = clientTimeOf();
      return db.transaction('rw', db.annotations, db.outbox, async () => {
        const existing = await db.annotations.get(id);
        if (existing === undefined || existing.userId !== userId || existing.bookId !== bookId) {
          return null;
        }

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
        await db.annotations.put(updated);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'annotation',
          entityId: updated.id,
          op: 'upsert',
          payload: annotationWritePayload(updated),
          clientUpdatedAt,
        });
        return updated;
      });
    },

    async deleteAnnotation(userId, bookId, id) {
      const clientUpdatedAt = clientTimeOf();
      await db.transaction('rw', db.annotations, db.outbox, async () => {
        const existing = await db.annotations.get(id);
        if (existing === undefined || existing.userId !== userId || existing.bookId !== bookId) {
          return;
        }

        await db.annotations.delete(id);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'annotation',
          entityId: id,
          op: 'delete',
          payload: undefined,
          clientUpdatedAt,
        });
      });
    },

    async listBookmarks(userId, bookId) {
      return db.bookmarks.where('[userId+bookId]').equals([userId, bookId]).toArray();
    },

    async createBookmark(userId, input) {
      const clientUpdatedAt = clientTimeOf();
      const row: LocalBookmarkRow = {
        id: newId(),
        bookId: input.bookId,
        locator: input.locator,
        label: normalizeBookmarkLabel(input.label),
        createdAt: clientUpdatedAt,
        updatedAt: clientUpdatedAt,
        userId,
        clientUpdatedAt,
        dirty: true,
      };
      await db.transaction('rw', db.bookmarks, db.outbox, async () => {
        await db.bookmarks.put(row);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'bookmark',
          entityId: row.id,
          op: 'upsert',
          payload: bookmarkWritePayload(row),
          clientUpdatedAt,
        });
      });
      return row;
    },

    async updateBookmark(userId, bookId, id, label) {
      const clientUpdatedAt = clientTimeOf();
      return db.transaction('rw', db.bookmarks, db.outbox, async () => {
        const existing = await db.bookmarks.get(id);
        if (existing === undefined || existing.userId !== userId || existing.bookId !== bookId) {
          return null;
        }

        const updated: LocalBookmarkRow = {
          ...existing,
          label: normalizeBookmarkLabel(label),
          updatedAt: clientUpdatedAt,
          clientUpdatedAt,
          dirty: true,
        };
        await db.bookmarks.put(updated);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'bookmark',
          entityId: updated.id,
          op: 'upsert',
          payload: bookmarkWritePayload(updated),
          clientUpdatedAt,
        });
        return updated;
      });
    },

    async deleteBookmark(userId, bookId, id) {
      const clientUpdatedAt = clientTimeOf();
      await db.transaction('rw', db.bookmarks, db.outbox, async () => {
        const existing = await db.bookmarks.get(id);
        if (existing === undefined || existing.userId !== userId || existing.bookId !== bookId) {
          return;
        }

        await db.bookmarks.delete(id);
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'bookmark',
          entityId: id,
          op: 'delete',
          payload: undefined,
          clientUpdatedAt,
        });
      });
    },

    async settingsFor(userId) {
      return (await db.settings.get(userId)) ?? null;
    },

    async saveSettings(userId, settings) {
      const clientUpdatedAt = clientTimeOf();
      await db.transaction('rw', db.settings, db.outbox, async () => {
        await db.settings.put({ userId, settings, clientUpdatedAt, dirty: true });
        await enqueue(db, {
          id: newId(),
          userId,
          entityType: 'reader_settings',
          entityId: userId,
          op: 'upsert',
          payload: { settings },
          clientUpdatedAt,
        });
      });
    },

    async pendingCount(userId) {
      return db.outbox.where('userId').equals(userId).count();
    },

    applyServerChange(userId, change, options) {
      const force = options?.force === true;
      switch (change.entityType) {
        case 'reading_progress':
          return applyProgressChange(db, userId, change, force);
        case 'annotation':
          return applyAnnotationChange(db, userId, change, force);
        case 'bookmark':
          return applyBookmarkChange(db, userId, change, force);
        case 'reader_settings':
          return applySettingsChange(db, userId, change, force);
        default: {
          const exhaustive: never = change.entityType;
          return exhaustive;
        }
      }
    },

    async applySnapshot(userId, snapshot) {
      await db.transaction(
        'rw',
        db.progress,
        db.annotations,
        db.bookmarks,
        db.settings,
        async () => {
          await db.progress.where('userId').equals(userId).delete();
          await db.annotations.where('userId').equals(userId).delete();
          await db.bookmarks.where('userId').equals(userId).delete();
          await db.settings.delete(userId);

          for (const entry of snapshot.progress) {
            const payload = readProgressPayload(entry);
            if (payload === null) {
              continue;
            }
            await db.progress.put({
              userId,
              bookId: payload.bookId,
              locator: payload.locator,
              percent: payload.percent,
              updatedAt: payload.updatedAt,
              clientUpdatedAt: payload.clientUpdatedAt,
              dirty: false,
            });
          }

          for (const entry of snapshot.annotations) {
            const payload = readAnnotationPayload(entry);
            if (payload === null) {
              continue;
            }
            await db.annotations.put({ ...payload, userId, dirty: false });
          }

          for (const entry of snapshot.bookmarks) {
            const payload = readBookmarkPayload(entry);
            if (payload === null) {
              continue;
            }
            await db.bookmarks.put({ ...payload, userId, dirty: false });
          }

          if (snapshot.settings !== null) {
            const payload = readSettingsPayload(snapshot.settings);
            if (payload !== null) {
              await db.settings.put({
                userId,
                settings: payload.settings,
                clientUpdatedAt: payload.clientUpdatedAt,
                dirty: false,
              });
            }
          }
        },
      );
    },

    async getCursor(userId) {
      return (await metaNumber(db, `${CURSOR_PREFIX}${userId}`)) ?? 0;
    },

    async setCursor(userId, cursor) {
      await db.meta.put({ key: `${CURSOR_PREFIX}${userId}`, value: cursor });
    },

    async getLastSyncedAt(userId) {
      return metaNumber(db, `${LAST_SYNCED_PREFIX}${userId}`);
    },

    async setLastSyncedAt(userId, at) {
      await db.meta.put({ key: `${LAST_SYNCED_PREFIX}${userId}`, value: at });
    },
  };
}
