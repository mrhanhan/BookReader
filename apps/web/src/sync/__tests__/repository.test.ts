import type { AnnotationColor, Locator, SyncChangeEnvelope } from '@bookr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createSyncDb, type BookrDb } from '../db';
import { createRepository, type LocalRepository } from '../repository';

const USER = 'user-reader';
const OTHER_USER = 'user-other';
const BOOK = '0198f0c0-0000-7000-8000-000000000001';
const OTHER_BOOK = '0198f0c0-0000-7000-8000-000000000002';
const SERVER_ANNOTATION = '0198f0c0-0000-7000-8000-0000000000aa';

const locator: Locator = { kind: 'pdf', page: 3, percent: 0.25 };
const laterLocator: Locator = { kind: 'pdf', page: 9, percent: 0.75 };

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const T3 = '2030-01-01T00:00:00.000Z';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let counter = 0;
let db: BookrDb;
let repo: LocalRepository;

beforeEach(() => {
  counter += 1;
  db = createSyncDb(`bookr-sync-test-${counter}`);
  repo = createRepository(db);
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.delete();
});

function annotationInput(
  overrides: Partial<Parameters<LocalRepository['createAnnotation']>[1]> = {},
): Parameters<LocalRepository['createAnnotation']>[1] {
  return {
    bookId: BOOK,
    type: 'highlight',
    color: 'yellow',
    locator,
    selectedText: '一段文字',
    noteText: null,
    tags: [],
    ...overrides,
  };
}

function progressEnvelope(clientUpdatedAt: string): SyncChangeEnvelope {
  return {
    revision: 1,
    entityType: 'reading_progress',
    entityId: BOOK,
    op: 'upsert',
    payload: {
      bookId: BOOK,
      locator: laterLocator,
      percent: laterLocator.percent,
      updatedAt: clientUpdatedAt,
      clientUpdatedAt,
    },
    clientUpdatedAt,
    serverUpdatedAt: clientUpdatedAt,
  };
}

describe('LocalRepository', () => {
  it('writes progress locally and enqueues one outbox row', async () => {
    const row = await repo.saveProgress(USER, BOOK, locator);

    expect(row.percent).toBe(locator.percent);
    expect(row.dirty).toBe(true);
    expect(await repo.pendingCount(USER)).toBe(1);

    const outbox = await db.outbox.where('userId').equals(USER).toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      entityType: 'reading_progress',
      entityId: BOOK,
      op: 'upsert',
      payload: { bookId: BOOK, locator },
    });
  });

  it('keeps one progress row per user and book', async () => {
    await repo.saveProgress(USER, BOOK, locator);
    await repo.saveProgress(USER, OTHER_BOOK, laterLocator);

    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
    expect((await repo.progressFor(USER, OTHER_BOOK))?.locator).toEqual(laterLocator);
    expect(await db.progress.count()).toBe(2);
  });

  it('does not let a legacy import overwrite a position written meanwhile', async () => {
    await repo.saveProgress(USER, BOOK, laterLocator, Date.parse(T2));

    const imported = await repo.importProgress(USER, BOOK, locator, Date.parse(T1));

    expect(imported.locator).toEqual(laterLocator);
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(laterLocator);
    // The import itself never queues anything; only the sync write remains.
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('creates annotations with a UUIDv7 id and a writable payload', async () => {
    const created = await repo.createAnnotation(USER, {
      ...annotationInput(),
      type: 'note',
      noteText: '我的想法',
      tags: ['  历史 ', '历史', '', '军事'],
    });

    expect(created.id).toMatch(UUID_V7);
    expect(created.tags).toEqual(['历史', '军事']);
    expect(created.revision).toBe(1);
    expect(await repo.listAnnotations(USER, BOOK)).toHaveLength(1);

    const outbox = await db.outbox.where('userId').equals(USER).toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]?.payload).toEqual({
      bookId: BOOK,
      type: 'note',
      color: 'yellow',
      locator,
      selectedText: '一段文字',
      noteText: '我的想法',
      tags: ['历史', '军事'],
    });
  });

  it('updates annotations locally and enqueues the merged write fields', async () => {
    const created = await repo.createAnnotation(USER, annotationInput());
    const updated = await repo.updateAnnotation(USER, BOOK, created.id, {
      color: 'blue' as AnnotationColor,
      tags: [' 重点 '],
    });

    expect(updated?.color).toBe('blue');
    expect(updated?.tags).toEqual(['重点']);
    expect(updated?.revision).toBe(2);
    expect((await repo.listAnnotations(USER, BOOK))[0]?.color).toBe('blue');

    const outbox = await db.outbox.where('userId').equals(USER).toArray();
    expect(outbox).toHaveLength(2);
    const blue = outbox.find((row) => (row.payload as { color?: string }).color === 'blue');
    expect(blue?.payload).toMatchObject({ color: 'blue', tags: ['重点'] });
  });

  it('lists annotations newest-edited first', async () => {
    let clock = Date.parse('2026-02-01T00:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const first = await repo.createAnnotation(USER, {
      ...annotationInput(),
      selectedText: '第一条',
    });
    clock += 1_000;
    const second = await repo.createAnnotation(USER, {
      ...annotationInput(),
      selectedText: '第二条',
    });
    expect((await repo.listAnnotations(USER, BOOK)).map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);

    clock += 1_000;
    await repo.updateAnnotation(USER, BOOK, first.id, { noteText: '更新旧批注' });

    expect((await repo.listAnnotations(USER, BOOK)).map((row) => row.id)).toEqual([
      first.id,
      second.id,
    ]);
    now.mockRestore();
  });

  it('deletes annotations and enqueues the delete', async () => {
    const created = await repo.createAnnotation(USER, annotationInput());
    await repo.deleteAnnotation(USER, BOOK, created.id);

    expect(await repo.listAnnotations(USER, BOOK)).toEqual([]);
    const outbox = await db.outbox.where('userId').equals(USER).toArray();
    expect(outbox.filter((row) => row.op === 'delete')).toHaveLength(1);
    expect(await repo.pendingCount(USER)).toBe(2);
  });

  it('updates and deletes bookmarks, enqueuing each mutation', async () => {
    const created = await repo.createBookmark(USER, {
      bookId: BOOK,
      locator,
      label: '  第一章  ',
    });
    expect(created.label).toBe('第一章');

    const updated = await repo.updateBookmark(USER, BOOK, created.id, '   ');
    expect(updated?.label).toBeNull();

    await repo.deleteBookmark(USER, BOOK, created.id);
    expect(await repo.listBookmarks(USER, BOOK)).toEqual([]);
    expect(await repo.pendingCount(USER)).toBe(3);

    const rows = await db.outbox.where('userId').equals(USER).toArray();
    expect(rows.filter((row) => row.op === 'upsert')).toHaveLength(2);
    expect(rows.filter((row) => row.op === 'delete')).toHaveLength(1);
    const cleared = rows.find(
      (row) => row.op === 'upsert' && (row.payload as { label?: string | null }).label === null,
    );
    expect(cleared?.payload).toEqual({ bookId: BOOK, locator, label: null });
  });

  it('lists bookmarks newest-created first', async () => {
    let clock = Date.parse('2026-02-01T00:00:00.000Z');
    const now = vi.spyOn(Date, 'now').mockImplementation(() => clock);

    const first = await repo.createBookmark(USER, { bookId: BOOK, locator, label: '第一处' });
    clock += 1_000;
    const second = await repo.createBookmark(USER, { bookId: BOOK, locator, label: '第二处' });

    expect((await repo.listBookmarks(USER, BOOK)).map((row) => row.id)).toEqual([
      second.id,
      first.id,
    ]);
    now.mockRestore();
  });

  it('saves reader settings with one outbox row', async () => {
    await repo.saveSettings(USER, { theme: 'dark', fontSize: 18 });

    expect((await repo.settingsFor(USER))?.settings).toEqual({ theme: 'dark', fontSize: 18 });
    const outbox = await db.outbox.where('userId').equals(USER).toArray();
    expect(outbox).toHaveLength(1);
    expect(outbox[0]).toMatchObject({
      entityType: 'reader_settings',
      entityId: USER,
      op: 'upsert',
      payload: { settings: { theme: 'dark', fontSize: 18 } },
    });
  });

  it('keeps local edits when a server change is older', async () => {
    await repo.saveProgress(USER, BOOK, locator, Date.parse(T2));

    const result = await repo.applyServerChange(USER, progressEnvelope(T1));

    expect(result).toBe('skipped');
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('overwrites local rows and drops their outbox when the server is newer', async () => {
    await repo.saveProgress(USER, BOOK, locator, Date.parse(T1));

    const result = await repo.applyServerChange(USER, progressEnvelope(T2));

    expect(result).toBe('applied');
    const row = await repo.progressFor(USER, BOOK);
    expect(row?.locator).toEqual(laterLocator);
    expect(row?.dirty).toBe(false);
    expect(await repo.pendingCount(USER)).toBe(0);
  });

  it('applies an equal-time server change and confirms the local write', async () => {
    await repo.saveProgress(USER, BOOK, locator, Date.parse(T1));

    const result = await repo.applyServerChange(USER, progressEnvelope(T1));

    expect(result).toBe('applied');
    const row = await repo.progressFor(USER, BOOK);
    expect(row?.locator).toEqual(laterLocator);
    expect(row?.dirty).toBe(false);
    expect(await repo.pendingCount(USER)).toBe(0);
  });

  it('applies an annotation upsert from the change log', async () => {
    const result = await repo.applyServerChange(USER, {
      revision: 4,
      entityType: 'annotation',
      entityId: SERVER_ANNOTATION,
      op: 'upsert',
      payload: {
        id: SERVER_ANNOTATION,
        bookId: BOOK,
        type: 'highlight',
        color: 'green',
        locator,
        selectedText: '服务端',
        noteText: null,
        tags: ['标签'],
        revision: 4,
        createdAt: T1,
        updatedAt: T2,
        clientUpdatedAt: T2,
      },
      clientUpdatedAt: T2,
      serverUpdatedAt: T2,
    });

    expect(result).toBe('applied');
    const rows = await repo.listAnnotations(USER, BOOK);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      id: SERVER_ANNOTATION,
      color: 'green',
      userId: USER,
      dirty: false,
    });
  });

  it('removes local rows on a newer server delete and drops their outbox', async () => {
    const created = await repo.createBookmark(USER, {
      bookId: BOOK,
      locator,
      label: '书签',
    });
    expect(await repo.pendingCount(USER)).toBe(1);

    const result = await repo.applyServerChange(USER, {
      revision: 3,
      entityType: 'bookmark',
      entityId: created.id,
      op: 'delete',
      payload: created,
      clientUpdatedAt: T3,
      serverUpdatedAt: T3,
    });

    expect(result).toBe('applied');
    expect(await repo.listBookmarks(USER, BOOK)).toEqual([]);
    expect(await repo.pendingCount(USER)).toBe(0);
  });

  it('keeps a newer local row when the server delete is older', async () => {
    const created = await repo.createBookmark(USER, {
      bookId: BOOK,
      locator,
      label: '本地较新',
    });

    const result = await repo.applyServerChange(USER, {
      revision: 3,
      entityType: 'bookmark',
      entityId: created.id,
      op: 'delete',
      payload: created,
      clientUpdatedAt: T1,
      serverUpdatedAt: T1,
    });

    expect(result).toBe('skipped');
    expect((await repo.listBookmarks(USER, BOOK)).map((row) => row.id)).toEqual([created.id]);
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('keeps newer local progress when the server delete is older', async () => {
    await repo.saveProgress(USER, BOOK, locator, Date.parse(T2));

    const result = await repo.applyServerChange(USER, {
      revision: 3,
      entityType: 'reading_progress',
      entityId: BOOK,
      op: 'delete',
      payload: null,
      clientUpdatedAt: T1,
      serverUpdatedAt: T1,
    });

    expect(result).toBe('skipped');
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('applies a snapshot without clearing the outbox', async () => {
    await repo.createBookmark(USER, { bookId: BOOK, locator, label: '本地书签' });

    await repo.applySnapshot(USER, {
      cursor: 42,
      progress: [
        {
          bookId: BOOK,
          locator,
          percent: locator.percent,
          updatedAt: T1,
          clientUpdatedAt: T1,
        },
      ],
      annotations: [
        {
          id: SERVER_ANNOTATION,
          bookId: BOOK,
          type: 'note',
          color: 'blue',
          locator,
          selectedText: '快照',
          noteText: '注释',
          tags: [],
          revision: 2,
          createdAt: T1,
          updatedAt: T2,
          clientUpdatedAt: T2,
        },
      ],
      bookmarks: [],
      settings: { settings: { theme: 'dark' }, updatedAt: T2, clientUpdatedAt: T2 },
    });

    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
    const annotations = await repo.listAnnotations(USER, BOOK);
    expect(annotations).toHaveLength(1);
    expect(annotations[0]?.dirty).toBe(false);
    expect(await repo.listBookmarks(USER, BOOK)).toEqual([]);
    expect((await repo.settingsFor(USER))?.settings).toEqual({ theme: 'dark' });
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('isolates users', async () => {
    await repo.saveProgress(USER, BOOK, locator);
    await repo.saveSettings(USER, { theme: 'dark' });
    await repo.setCursor(USER, 7);
    await repo.setLastSyncedAt(USER, 1_700_000_000_000);

    expect(await repo.progressFor(OTHER_USER, BOOK)).toBeNull();
    expect(await repo.settingsFor(OTHER_USER)).toBeNull();
    expect(await repo.pendingCount(OTHER_USER)).toBe(0);
    expect(await repo.getCursor(OTHER_USER)).toBe(0);
    expect(await repo.getLastSyncedAt(OTHER_USER)).toBeNull();

    await repo.createBookmark(OTHER_USER, { bookId: OTHER_BOOK, locator, label: '别人的' });
    expect(await repo.listBookmarks(USER, OTHER_BOOK)).toEqual([]);
    expect(await repo.pendingCount(USER)).toBe(2);
  });

  it('persists the cursor and last sync time per user', async () => {
    expect(await repo.getCursor(USER)).toBe(0);
    expect(await repo.getLastSyncedAt(USER)).toBeNull();

    await repo.setCursor(USER, 12);
    await repo.setLastSyncedAt(USER, 1_700_000_000_000);

    expect(await repo.getCursor(USER)).toBe(12);
    expect(await repo.getLastSyncedAt(USER)).toBe(1_700_000_000_000);
  });
});
