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

describe('SyncEngine', () => {  it('pushes queued changes and clears the outbox', async () => {
    const api = createFakeApi();
    api.push = vi.fn(async (changes: SyncPushChange[]) => appliedEcho(changes));
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

  it('force-applies the pushed echo when the client clock runs ahead', async () => {
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

  it('pulls to the end and advances the cursor', async () => {
    const api = createFakeApi();
    const first = bookmarkChange(1);
    const second = bookmarkChange(2);
    api.pull = vi
      .fn()
      .mockResolvedValueOnce({ changes: [first], cursor: 1, hasMore: true, reset: false })
      .mockResolvedValueOnce({ changes: [second], cursor: 2, hasMore: false, reset: false });
    engine = testEngine(api);

    await engine.syncNow();

    expect(api.pull).toHaveBeenCalledTimes(2);
    expect(vi.mocked(api.pull).mock.calls[1]?.[0]).toBe(1);
    expect(await repo.getCursor(USER)).toBe(2);
    const bookmarks = await repo.listBookmarks(USER, BOOK);
    expect(bookmarks.map((row) => row.id)).toEqual([first.entityId, second.entityId]);
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
    await repo.saveProgress(USER, OTHER_BOOK, laterLocator);
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
    expect(engine.getState().status).toBe('synced');
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
});
