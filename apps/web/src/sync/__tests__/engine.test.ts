import { syncKey } from '@bookr/shared';
import type {
  Locator,
  SyncChangeEnvelope,
  SyncPullResult,
  SyncPushChange,
  SyncPushResult,
  SyncSnapshot,
} from '@bookr/shared';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError } from '../../api/client';
import type { SyncApi } from '../../api/sync';
import { createSyncDb, type BookrDb } from '../db';
import { createSyncEngine, type EventSourceLike, type SyncEngine } from '../engine';
import type { SyncEngineOptions } from '../engine';
import { createRepository, type LocalRepository } from '../repository';

const USER = 'user-reader';
const BOOK = '0198f0c0-0000-7000-8000-000000000001';
const OTHER_BOOK = '0198f0c0-0000-7000-8000-000000000002';

const locator: Locator = { kind: 'pdf', page: 3, percent: 0.25 };
const laterLocator: Locator = { kind: 'pdf', page: 9, percent: 0.75 };

const T1 = '2026-01-01T00:00:00.000Z';
const T2 = '2026-01-02T00:00:00.000Z';
const NOW = 1_700_000_000_000;

let counter = 0;
let db: BookrDb;
let repo: LocalRepository;
let engine: SyncEngine | null;

beforeEach(() => {
  counter += 1;
  db = createSyncDb(`bookr-engine-test-${counter}`);
  repo = createRepository(db);
  engine = null;
  FakeEventSource.instances = [];
});

afterEach(async () => {
  await engine?.stop();
  vi.restoreAllMocks();
  await db.delete();
});

class FakeEventSource implements EventSourceLike {
  static instances: FakeEventSource[] = [];
  readonly listeners = new Map<string, Array<(event: MessageEvent) => void>>();
  closed = false;

  constructor(readonly url: string) {
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (event: MessageEvent) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit(type: string, data?: unknown): void {
    const event = { data: data === undefined ? '' : JSON.stringify(data) } as MessageEvent;
    for (const listener of this.listeners.get(type) ?? []) {
      listener(event);
    }
  }
}

const emptyPull = (since: number): SyncPullResult => ({
  changes: [],
  cursor: since,
  hasMore: false,
  reset: false,
});

const emptyPush: SyncPushResult = { applied: [], skipped: [], rejected: [], cursor: 0 };

const emptySnapshot: SyncSnapshot = {
  cursor: 0,
  progress: [],
  annotations: [],
  bookmarks: [],
  settings: null,
};

function createFakeApi(): SyncApi {
  return {
    push: vi.fn(async () => emptyPush),
    pull: vi.fn(async (since: number) => emptyPull(since)),
    snapshot: vi.fn(async () => emptySnapshot),
    streamToken: vi.fn(async () => ({ token: 'stream-token', expiresIn: 60 })),
  };
}

function testEngine(options: SyncApi, overrides: Partial<SyncEngineOptions> = {}): SyncEngine {
  return createSyncEngine({
    userId: USER,
    db,
    repo,
    api: options,
    online: () => true,
    now: () => NOW,
    ...overrides,
  });
}

function bookmarkChange(revision: number, overrides: Partial<SyncChangeEnvelope> = {}): SyncChangeEnvelope {
  const entityId = `0198f0c0-0000-7000-8000-0000000000${String(revision).padStart(2, '0')}`;
  return {
    revision,
    entityType: 'bookmark',
    entityId,
    op: 'upsert',
    payload: {
      id: entityId,
      bookId: BOOK,
      locator,
      label: null,
      createdAt: T1,
      updatedAt: T1,
      clientUpdatedAt: T1,
    },
    clientUpdatedAt: T1,
    serverUpdatedAt: T1,
    ...overrides,
  };
}

function appliedEcho(changes: SyncPushChange[]): SyncPushResult {
  return {
    applied: changes.map((change, index) => ({
      revision: index + 1,
      entityType: change.entityType,
      entityId: change.entityId,
      op: change.op,
      // The server returns the canonical log payload, not the push write fields.
      payload: {
        bookId: BOOK,
        locator,
        percent: locator.percent,
        updatedAt: change.clientUpdatedAt,
        clientUpdatedAt: change.clientUpdatedAt,
      },
      clientUpdatedAt: change.clientUpdatedAt,
      serverUpdatedAt: change.clientUpdatedAt,
    })),
    skipped: [],
    rejected: [],
    cursor: changes.length,
  };
}

describe('SyncEngine', () => {
  it('pushes queued changes and clears the outbox', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async (changes: SyncPushChange[]) => appliedEcho(changes));
    // The first sync takes a snapshot; it echoes what the push just confirmed.
    api.snapshot = vi.fn(async () => ({
      cursor: 1,
      progress: [
        { bookId: BOOK, locator, percent: locator.percent, updatedAt: T1, clientUpdatedAt: T1 },
      ],
      annotations: [],
      bookmarks: [],
      settings: null,
    }));
    await repo.saveProgress(USER, BOOK, locator);
    const onChange = vi.fn();
    engine = testEngine(api, { onChange });

    await engine.syncNow('test');

    expect(api.push).toHaveBeenCalledTimes(1);
    expect(vi.mocked(api.push).mock.calls[0]?.[0]).toHaveLength(1);
    expect(await repo.pendingCount(USER)).toBe(0);
    expect((await repo.progressFor(USER, BOOK))?.dirty).toBe(false);
    expect(onChange).toHaveBeenCalledWith(expect.anything(), {
      type: 'applied',
      entityType: 'reading_progress',
    });
  });

  it('applies the pushed echo after clearing the batch when the client clock runs ahead', async () => {
    const api = createFakeApi();
    const clamped = new Date(NOW).toISOString();
    api.push = vi.fn(async (changes: SyncPushChange[]) => ({
      applied: changes.map((change, index) => ({
        revision: index + 1,
        entityType: change.entityType,
        entityId: change.entityId,
        op: change.op,
        payload: {
          bookId: BOOK,
          locator: laterLocator,
          percent: laterLocator.percent,
          updatedAt: clamped,
          clientUpdatedAt: clamped,
        },
        clientUpdatedAt: clamped,
        serverUpdatedAt: clamped,
      })),
      skipped: [],
      rejected: [],
      cursor: 1,
    }));
    api.snapshot = vi.fn(async () => ({
      cursor: 1,
      progress: [
        {
          bookId: BOOK,
          locator: laterLocator,
          percent: laterLocator.percent,
          updatedAt: clamped,
          clientUpdatedAt: clamped,
        },
      ],
      annotations: [],
      bookmarks: [],
      settings: null,
    }));
    // The client clock is ten minutes ahead, so the server echoes a smaller time.
    await repo.saveProgress(USER, BOOK, locator, NOW + 10 * 60 * 1000);
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.push).toHaveBeenCalledTimes(1);
    const row = await repo.progressFor(USER, BOOK);
    expect(row?.locator).toEqual(laterLocator);
    expect(row?.clientUpdatedAt).toBe(clamped);
    expect(row?.dirty).toBe(false);
    expect(await repo.pendingCount(USER)).toBe(0);
  });

  it('keeps a local write made while the push was in flight', async () => {
    const api = createFakeApi();
    let calls = 0;
    api.push = vi.fn(async (changes: SyncPushChange[]) => {
      calls += 1;
      if (calls === 1) {
        // The user edits again while the first batch is on the wire.
        await repo.saveProgress(USER, BOOK, laterLocator, NOW + 1000);
        return appliedEcho(changes);
      }
      return { applied: [], skipped: [], rejected: [], cursor: 0 };
    });
    await repo.saveProgress(USER, BOOK, locator, NOW);
    engine = testEngine(api);

    await engine.syncNow();

    const row = await repo.progressFor(USER, BOOK);
    expect(row?.locator).toEqual(laterLocator);
    expect(row?.clientUpdatedAt).toBe(new Date(NOW + 1000).toISOString());
    expect(row?.dirty).toBe(true);
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('pulls to the end and advances the cursor', async () => {
    const api = createFakeApi();
    const first = bookmarkChange(5);
    const second = bookmarkChange(9);
    api.pull = vi
      .fn()
      // With more pages the cursor is the log head, not this page's last row.
      .mockResolvedValueOnce({ changes: [first], cursor: 9, hasMore: true, reset: false })
      .mockResolvedValueOnce({ changes: [second], cursor: 9, hasMore: false, reset: false });
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.pull).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.pull).mock.calls[1]?.[0]).toBe(5);
    expect(await repo.getCursor(USER)).toBe(9);
    const bookmarks = await repo.listBookmarks(USER, BOOK);
    // Both carry the same creation time, so the newer id lists first.
    expect(bookmarks.map((row) => row.id)).toEqual([second.entityId, first.entityId]);
    expect(engine.getState().lastApplied).toMatchObject({
      entityType: 'bookmark',
      entityId: second.entityId,
      source: 'pull',
    });
  });

  it('rebuilds from a snapshot when the pull reports reset', async () => {
    const api = createFakeApi();
    api.pull = vi.fn(async () => ({ changes: [], cursor: 10, hasMore: false, reset: true }));
    api.snapshot = vi.fn(async () => ({
      cursor: 10,
      progress: [
        { bookId: BOOK, locator, percent: locator.percent, updatedAt: T1, clientUpdatedAt: T1 },
      ],
      annotations: [],
      bookmarks: [],
      settings: { settings: { theme: 'dark' }, clientUpdatedAt: T1 },
    }));
    // A local row that is not on the server must disappear with the snapshot;
    // it is imported directly so no pending outbox row postpones it. An
    // existing cursor keeps the bootstrap snapshot out of the way.
    await repo.importProgress(USER, OTHER_BOOK, laterLocator, NOW);
    await repo.setCursor(USER, 1);
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(await repo.getCursor(USER)).toBe(10);
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
    expect(await repo.progressFor(USER, OTHER_BOOK)).toBeNull();
    expect((await repo.settingsFor(USER))?.settings).toEqual({ theme: 'dark' });
  });

  it('applies a stream event and advances the cursor', async () => {
    const api = createFakeApi();
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    expect(source?.url).toContain('/api/sync/stream?token=stream-token');
    expect(source?.url).toContain('since=0');

    const change = bookmarkChange(5);
    source?.emit('change', change);

    await vi.waitFor(async () => {
      expect(await repo.getCursor(USER)).toBe(5);
    });
    await vi.waitFor(async () => {
      expect(await repo.listBookmarks(USER, BOOK)).toHaveLength(1);
    });

    // Frames at or below the cursor are ignored, even if they arrive late.
    source?.emit(
      'change',
      bookmarkChange(3, {
        entityId: change.entityId,
        payload: { ...(change.payload as Record<string, unknown>), label: '旧帧' },
      }),
    );
    source?.emit('change', bookmarkChange(6));
    await vi.waitFor(async () => {
      expect(await repo.getCursor(USER)).toBe(6);
    });
    const rows = await repo.listBookmarks(USER, BOOK);
    expect(rows.find((row) => row.id === change.entityId)?.label).toBeNull();
    expect(engine.getState().status).toBe('synced');
  });

  it('rebuilds from a snapshot when the stream reports reset', async () => {
    const api = createFakeApi();
    api.snapshot = vi.fn(async () => ({
      cursor: 12,
      progress: [
        { bookId: BOOK, locator, percent: locator.percent, updatedAt: T1, clientUpdatedAt: T1 },
      ],
      annotations: [],
      bookmarks: [],
      settings: null,
    }));
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    FakeEventSource.instances[0]?.emit('reset');

    await vi.waitFor(async () => {
      expect(await repo.getCursor(USER)).toBe(12);
    });
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
  });

  it('syncs when the browser comes online or the page becomes visible', async () => {
    const api = createFakeApi();
    let pulls = 0;
    api.pull = vi.fn(async (since: number) => {
      pulls += 1;
      return emptyPull(since);
    });
    engine = testEngine(api);

    engine.start();
    await vi.waitFor(() => expect(pulls).toBe(1));

    window.dispatchEvent(new Event('online'));
    await vi.waitFor(() => expect(pulls).toBe(2));

    document.dispatchEvent(new Event('visibilitychange'));
    await vi.waitFor(() => expect(pulls).toBe(3));
  });

  it('waits for an in-flight sync when stopping', async () => {
    const api = createFakeApi();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let pushed = false;
    api.push = vi.fn(async () => {
      await gate;
      pushed = true;
      return { applied: [], skipped: [], rejected: [], cursor: 0 };
    });
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    const sync = engine.syncNow();
    await vi.waitFor(() => expect(api.push).toHaveBeenCalled());

    let stopResolved = false;
    const stopping = engine.stop().then(() => {
      stopResolved = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(stopResolved).toBe(false);

    release?.();
    await stopping;
    await sync;
    expect(pushed).toBe(true);
    expect(stopResolved).toBe(true);
  });

  it('does not let a stale state refresh overwrite a completed sync', async () => {
    const api = createFakeApi();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const slowRepo: LocalRepository = {
      ...repo,
      getLastSyncedAt: async () => {
        await gate;
        return 999;
      },
    };
    engine = testEngine(api, { repo: slowRepo });

    engine.start();
    await vi.waitFor(() => expect(engine?.getState().lastSyncedAt).toBe(NOW));

    release?.();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(engine.getState().lastSyncedAt).toBe(NOW);
  });

  it('reconnects with backoff after a stream error', async () => {
    // Spy instead of faking timers so fake-indexeddb keeps running; the test
    // drives the scheduled reconnect callbacks itself.
    const delaySpy = vi.spyOn(globalThis, 'setTimeout');
    const api = createFakeApi();
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const runReconnect = (expectedDelay: number): void => {
      const call = [...delaySpy.mock.calls]
        .reverse()
        .find((entry) => typeof entry[0] === 'function' && entry[1] === expectedDelay);
      expect(call).toBeDefined();
      const callback = call?.[0] as (() => void) | undefined;
      callback?.();
    };

    FakeEventSource.instances[0]?.emit('error');
    await vi.waitFor(() => {
      expect(delaySpy).toHaveBeenCalledWith(expect.any(Function), 1000);
    });
    expect(FakeEventSource.instances).toHaveLength(1);
    runReconnect(1000);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    FakeEventSource.instances[1]?.emit('error');
    await vi.waitFor(() => {
      expect(delaySpy).toHaveBeenCalledWith(expect.any(Function), 2000);
    });
    runReconnect(2000);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(3));

    FakeEventSource.instances[2]?.emit('error');
    await vi.waitFor(() => {
      expect(delaySpy).toHaveBeenCalledWith(expect.any(Function), 5000);
    });
    runReconnect(5000);
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(4));

    delaySpy.mockRestore();
  });

  it('resets the reconnect backoff when the stream opens', async () => {
    const delaySpy = vi.spyOn(globalThis, 'setTimeout');
    const api = createFakeApi();
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));

    const countDelay = (delay: number): number =>
      delaySpy.mock.calls.filter((entry) => typeof entry[0] === 'function' && entry[1] === delay)
        .length;

    FakeEventSource.instances[0]?.emit('error');
    await vi.waitFor(() => expect(countDelay(1000)).toBe(1));
    const reconnect = [...delaySpy.mock.calls]
      .reverse()
      .find((entry) => typeof entry[0] === 'function' && entry[1] === 1000);
    (reconnect?.[0] as (() => void) | undefined)?.();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));

    FakeEventSource.instances[1]?.emit('open');
    FakeEventSource.instances[1]?.emit('error');
    await vi.waitFor(() => expect(countDelay(1000)).toBe(2));

    delaySpy.mockRestore();
  });

  it('reports offline without clearing pending changes', async () => {
    const api = createFakeApi();
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api, { online: () => false });

    await engine.syncNow();

    expect(engine.getState().status).toBe('offline');
    expect(engine.getState().pending).toBe(1);
    expect(await repo.pendingCount(USER)).toBe(1);
    expect(api.push).not.toHaveBeenCalled();
  });

  it('runs one sync at a time and re-runs once when triggered mid-flight', async () => {
    const api = createFakeApi();
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let calls = 0;
    let active = 0;
    let maxActive = 0;
    api.push = vi.fn(async () => {
      calls += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (calls === 1) {
        await gate;
      }
      active -= 1;
      return { applied: [], skipped: [], rejected: [], cursor: 0 };
    });
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    const first = engine.syncNow();
    const second = engine.syncNow();
    const third = engine.syncNow();
    await vi.waitFor(() => expect(calls).toBe(1));

    release?.();
    await Promise.all([first, second, third]);

    expect(calls).toBe(2);
    expect(maxActive).toBe(1);
  });

  it('marks a server-skipped change clean and drops its outbox row', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async (changes: SyncPushChange[]) => ({
      applied: [],
      skipped: changes.map((change) => syncKey(change.entityType, change.entityId)),
      rejected: [],
      cursor: 0,
    }));
    // The bootstrap snapshot echoes the position the server already holds.
    api.snapshot = vi.fn(async () => ({
      cursor: 1,
      progress: [
        { bookId: BOOK, locator, percent: locator.percent, updatedAt: T1, clientUpdatedAt: T1 },
      ],
      annotations: [],
      bookmarks: [],
      settings: null,
    }));
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    await engine.syncNow();

    expect(await repo.pendingCount(USER)).toBe(0);
    expect((await repo.progressFor(USER, BOOK))?.dirty).toBe(false);
  });

  it('does not count a skipped session heartbeat as a conflict', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async (changes: SyncPushChange[]) => ({
      applied: [],
      skipped: changes.map((change) => syncKey(change.entityType, change.entityId)),
      rejected: [],
      cursor: 0,
    }));
    api.snapshot = vi.fn(async () => ({
      cursor: 1,
      progress: [],
      annotations: [],
      bookmarks: [],
      settings: null,
    }));
    await repo.saveReadingSession(USER, {
      id: '0198f0c0-0000-7000-8000-0000000000bb',
      bookId: BOOK,
      startedAt: T1,
      endedAt: T1,
      activeSeconds: 30,
      pagesRead: 1,
    });
    engine = testEngine(api);

    await engine.syncNow();

    expect(await repo.pendingCount(USER)).toBe(0);
    expect(engine.getState().conflicts).toBe(0);
  });

  it('ignores stream frames after stopping', async () => {
    const api = createFakeApi();
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const source = FakeEventSource.instances[0];
    await engine.stop();

    source?.emit('change', bookmarkChange(5));
    await new Promise((resolve) => setTimeout(resolve, 10));

    expect(await repo.getCursor(USER)).toBe(0);
    expect(await repo.listBookmarks(USER, BOOK)).toHaveLength(0);
  });

  it('drops rejected changes from the outbox and counts them', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async (changes: SyncPushChange[]) => ({
      applied: [],
      skipped: [],
      rejected: changes.map((change) => ({
        key: syncKey(change.entityType, change.entityId),
        reason: 'invalid_payload' as const,
      })),
      cursor: 0,
    }));
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    await engine.syncNow();

    expect(await repo.pendingCount(USER)).toBe(0);
    const errors = await db.meta.get(`syncErrors:${USER}`);
    expect(errors?.value).toBe(1);
  });

  it('bootstraps from the server snapshot when the device has no cursor', async () => {
    const api = createFakeApi();
    api.snapshot = vi.fn(async () => ({
      cursor: 8,
      progress: [
        { bookId: BOOK, locator, percent: locator.percent, updatedAt: T1, clientUpdatedAt: T1 },
      ],
      annotations: [],
      bookmarks: [],
      settings: { settings: { theme: 'dark' }, clientUpdatedAt: T1 },
    }));
    engine = testEngine(api);

    await engine.syncNow('first-open');

    expect(api.snapshot).toHaveBeenCalledTimes(1);
    expect(await repo.getCursor(USER)).toBe(8);
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);
    expect((await repo.settingsFor(USER))?.settings).toEqual({ theme: 'dark' });
    // The pull resumes from the snapshot instead of replaying the whole log.
    expect(vi.mocked(api.pull).mock.calls[0]?.[0]).toBe(8);

    await engine.syncNow('second-run');

    expect(api.snapshot).toHaveBeenCalledTimes(1);
  });

  it('remembers the bootstrap even when the server snapshot is empty', async () => {
    const api = createFakeApi();
    engine = testEngine(api);

    await engine.syncNow();
    await engine.syncNow();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
  });

  it('does not snapshot when a cursor already exists', async () => {
    await repo.setCursor(USER, 4);
    const api = createFakeApi();
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.snapshot).not.toHaveBeenCalled();
    expect(await repo.getCursor(USER)).toBe(4);
  });

  it('keeps the newest state when revisions arrive out of order', async () => {
    const api = createFakeApi();
    const entityId = '0198f0c0-0000-7000-8000-0000000000aa';
    const envelope = (revision: number, label: string, at: string): SyncChangeEnvelope => ({
      revision,
      entityType: 'bookmark',
      entityId,
      op: 'upsert',
      payload: {
        id: entityId,
        bookId: BOOK,
        locator,
        label,
        createdAt: T1,
        updatedAt: at,
        clientUpdatedAt: at,
      },
      clientUpdatedAt: at,
      serverUpdatedAt: at,
    });
    api.pull = vi.fn(async () => ({
      changes: [envelope(5, '新', T2), envelope(3, '旧', T1)],
      cursor: 5,
      hasMore: false,
      reset: false,
    }));
    engine = testEngine(api);

    await engine.syncNow();

    expect(await repo.getCursor(USER)).toBe(5);
    const rows = await repo.listBookmarks(USER, BOOK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('新');
  });

  it('backs off a failed push before retrying', async () => {
    let clock = NOW;
    const api = createFakeApi();
    api.push = vi.fn(async () => {
      throw new TypeError('network down');
    });
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api, { now: () => clock });

    await engine.syncNow();

    expect(api.push).toHaveBeenCalledTimes(1);
    expect(await repo.pendingCount(USER)).toBe(1);
    const [failed] = await db.outbox.toArray();
    expect(failed?.attempts).toBe(1);
    expect(failed?.nextAttemptAt).toBe(NOW + 2000);

    // Still inside the backoff window: the next sync must not re-push.
    await engine.syncNow();
    expect(api.push).toHaveBeenCalledTimes(1);

    clock = NOW + 2000;
    await engine.syncNow();
    expect(api.push).toHaveBeenCalledTimes(2);
  });

  it('splits a batch the server rejects as too large', async () => {
    const api = createFakeApi();
    let calls = 0;
    api.push = vi.fn(async (changes: SyncPushChange[]) => {
      calls += 1;
      if (calls === 1) {
        throw new ApiError(413, 'VALIDATION_FAILED', 'payload too large');
      }
      return appliedEcho(changes);
    });
    await repo.createBookmark(USER, { bookId: BOOK, locator, label: '一' });
    await repo.createBookmark(USER, { bookId: BOOK, locator, label: '二' });
    await repo.createBookmark(USER, { bookId: BOOK, locator, label: '三' });
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.push).toHaveBeenCalledTimes(3);
    expect(await repo.pendingCount(USER)).toBe(0);
  });

  it('drops a single change that is still too large', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async () => {
      throw new ApiError(413, 'VALIDATION_FAILED', 'payload too large');
    });
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.push).toHaveBeenCalledTimes(1);
    expect(await repo.pendingCount(USER)).toBe(0);
    const errors = await db.meta.get(`syncErrors:${USER}`);
    expect(errors?.value).toBe(1);
  });

  it('publishes offline immediately and reconnects when the browser returns', async () => {
    const api = createFakeApi();
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    const first = FakeEventSource.instances[0];

    window.dispatchEvent(new Event('offline'));

    await vi.waitFor(() => expect(engine?.getState().status).toBe('offline'));
    expect(first?.closed).toBe(true);

    window.dispatchEvent(new Event('online'));

    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(2));
  });

  it('does not let a stale push echo overwrite a newer stream frame', async () => {
    const api = createFakeApi();
    const echoTime = '2030-01-01T00:00:00.000Z';
    const frameTime = '2031-01-01T00:00:00.000Z';

    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });
    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await vi.waitFor(() => expect(api.pull).toHaveBeenCalled());

    const created = await repo.createBookmark(USER, {
      bookId: BOOK,
      locator,
      label: '本地',
    });
    let release: (() => void) | undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Revision 8 is stale by the time the response lands; the stream moved
    // the entity to revision 10 while the push was in flight.
    api.push = vi.fn(async () => {
      await gate;
      return {
        applied: [
          {
            revision: 8,
            entityType: 'bookmark' as const,
            entityId: created.id,
            op: 'upsert' as const,
            payload: {
              id: created.id,
              bookId: BOOK,
              locator,
              label: '旧',
              createdAt: T1,
              updatedAt: echoTime,
              clientUpdatedAt: echoTime,
            },
            clientUpdatedAt: echoTime,
            serverUpdatedAt: echoTime,
          },
        ],
        skipped: [],
        rejected: [],
        cursor: 8,
      };
    });

    const syncing = engine.syncNow();
    await vi.waitFor(() => expect(api.push).toHaveBeenCalled());

    FakeEventSource.instances[0]?.emit('change', {
      revision: 10,
      entityType: 'bookmark',
      entityId: created.id,
      op: 'upsert',
      payload: {
        id: created.id,
        bookId: BOOK,
        locator,
        label: '新',
        createdAt: T1,
        updatedAt: frameTime,
        clientUpdatedAt: frameTime,
      },
      clientUpdatedAt: frameTime,
      serverUpdatedAt: frameTime,
    });
    await vi.waitFor(async () => expect(await repo.getCursor(USER)).toBe(10));
    await vi.waitFor(async () => {
      expect((await repo.listBookmarks(USER, BOOK))[0]?.label).toBe('新');
    });

    release?.();
    await syncing;

    const rows = await repo.listBookmarks(USER, BOOK);
    expect(rows).toHaveLength(1);
    expect(rows[0]?.label).toBe('新');
    expect(await repo.pendingCount(USER)).toBe(0);
  });

  it('recovers on the next sync when the online event never arrives', async () => {
    const api = createFakeApi();
    let networkUp = true;
    engine = testEngine(api, {
      online: () => networkUp,
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(api.pull).toHaveBeenCalledTimes(1));

    networkUp = false;
    window.dispatchEvent(new Event('offline'));
    await vi.waitFor(() => expect(engine?.getState().status).toBe('offline'));

    // The host never dispatches `online`; the probe is authoritative again.
    networkUp = true;
    await engine.syncNow('recover');

    expect(engine.getState().status).toBe('synced');
    expect(api.pull).toHaveBeenCalledTimes(2);
  });

  it('forces a snapshot after repeated deferrals while writes stay pending', async () => {
    const api = createFakeApi();
    // Nothing is acknowledged, so the local write stays queued across syncs.
    api.push = vi.fn(async () => emptyPush);
    api.pull = vi.fn(async (since: number) => ({
      changes: [],
      cursor: since,
      hasMore: false,
      reset: true,
    }));
    api.snapshot = vi.fn(async () => ({
      cursor: 6,
      progress: [],
      annotations: [],
      bookmarks: [],
      settings: null,
    }));
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    // Each sync offers two snapshot decisions (bootstrap, then the reset
    // pull); five deferrals are reached during the third sync.
    await engine.syncNow();
    await engine.syncNow();
    expect(api.snapshot).not.toHaveBeenCalled();

    await engine.syncNow();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
    // The snapshot never clears the outbox; the payload is retried later.
    expect(await repo.pendingCount(USER)).toBe(1);
  });

  it('postpones a reset snapshot while the outbox still has pending writes', async () => {
    const api = createFakeApi();
    // Nothing is acknowledged, so the local write stays queued.
    api.push = vi.fn(async () => emptyPush);
    let pulls = 0;
    api.pull = vi.fn(async (since: number) => {
      pulls += 1;
      return pulls === 1
        ? { changes: [], cursor: 6, hasMore: false, reset: true }
        : emptyPull(since);
    });
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.snapshot).not.toHaveBeenCalled();
    expect(await repo.pendingCount(USER)).toBe(1);
    expect((await repo.progressFor(USER, BOOK))?.locator).toEqual(locator);

    await db.outbox.clear();
    await engine.syncNow();

    expect(api.snapshot).toHaveBeenCalledTimes(1);
  });

  it('postpones a stream rebuild while the outbox still has pending writes', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async () => emptyPush);
    await repo.saveProgress(USER, BOOK, locator);
    engine = testEngine(api, {
      eventSourceFactory: (url) => new FakeEventSource(url),
    });

    engine.start();
    await vi.waitFor(() => expect(FakeEventSource.instances).toHaveLength(1));
    await vi.waitFor(() => expect(api.pull).toHaveBeenCalled());

    FakeEventSource.instances[0]?.emit('reset');
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(api.snapshot).not.toHaveBeenCalled();

    await db.outbox.clear();
    FakeEventSource.instances[0]?.emit('reset');
    await vi.waitFor(() => expect(api.snapshot).toHaveBeenCalledTimes(1));
  });
});
