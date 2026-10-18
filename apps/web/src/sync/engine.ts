import { SYNC_PUSH_MAX_CHANGES, syncKey } from '@bookr/shared';
import type { SyncChangeEnvelope, SyncEntityType, SyncPushChange } from '@bookr/shared';
import { syncStreamUrl } from '../api/sync';
import type { SyncApi } from '../api/sync';
import type { BookrDb } from './db';
import { acknowledgeOutbox, dueOutbox } from './outbox';
import type { OutboxRow } from './types';
import type { LocalRepository } from './repository';

export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error';

export interface SyncState {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: number | null;
  conflicts: number;
}

export interface EventSourceLike {
  addEventListener(type: string, listener: (event: MessageEvent) => void): void;
  close(): void;
}

export interface SyncEngineOptions {
  userId: string;
  /** The engine reads and acknowledges the outbox directly; `repo` owns local rows. */
  db: BookrDb;
  repo: LocalRepository;
  api: SyncApi;
  online?: () => boolean;
  now?: () => number;
  eventSourceFactory?: (url: string) => EventSourceLike;
  onChange?: (
    state: SyncState,
    event?: { type: 'applied' | 'conflict'; entityType: SyncEntityType },
  ) => void;
}

export interface SyncEngine {
  start(): void;
  stop(): Promise<void>;
  syncNow(reason?: string): Promise<void>;
  getState(): SyncState;
  subscribe(listener: (state: SyncState) => void): () => void;
}

/** Reconnect delays after a stream error, then pause at the last value. */
const RECONNECT_DELAYS = [1000, 2000, 5000, 15000, 30000];
const HEARTBEAT_MS = 60_000;
const SYNC_ERRORS_PREFIX = 'syncErrors:';

interface SyncEvent {
  type: 'applied' | 'conflict';
  entityType: SyncEntityType;
}

export function createSyncEngine(options: SyncEngineOptions): SyncEngine {
  const { userId, db, repo, api } = options;
  const online = options.online ?? (() => typeof navigator === 'undefined' || navigator.onLine);
  const now = options.now ?? (() => Date.now());
  const eventSourceFactory = options.eventSourceFactory;
  const onChange = options.onChange;

  let started = false;
  let stopped = false;
  let syncing = false;
  let pending = 0;
  let lastSyncedAt: number | null = null;
  let lastError = false;
  let conflicts = 0;

  let running: Promise<void> | null = null;
  let rerunRequested = false;

  let stream: EventSourceLike | null = null;
  let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  let reconnectIndex = 0;
  let heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  let onlineListener: (() => void) | null = null;
  let visibilityListener: (() => void) | null = null;

  const listeners = new Set<(state: SyncState) => void>();

  function computeState(): SyncState {
    let status: SyncStatus;
    if (!online()) {
      status = 'offline';
    } else if (syncing) {
      status = 'syncing';
    } else if (pending > 0) {
      status = 'pending';
    } else if (lastError) {
      status = 'error';
    } else {
      status = 'synced';
    }
    return { status, pending, lastSyncedAt, conflicts };
  }

  let state = computeState();

  function publish(event?: SyncEvent): void {
    const next = computeState();
    const changed =
      next.status !== state.status ||
      next.pending !== state.pending ||
      next.lastSyncedAt !== state.lastSyncedAt ||
      next.conflicts !== state.conflicts;
    state = next;
    if (!changed && event === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener(state);
    }
    onChange?.(state, event);
  }

  async function refreshPending(): Promise<void> {
    pending = await repo.pendingCount(userId);
  }

  async function refreshState(): Promise<void> {
    pending = await repo.pendingCount(userId);
    lastSyncedAt = await repo.getLastSyncedAt(userId);
    publish();
  }

  /** Push every due batch, then pull pages until the server reports the end. */
  async function runOnce(): Promise<void> {
    if (!online()) {
      await refreshPending();
      publish();
      return;
    }

    syncing = true;
    publish();
    try {
      await pushAll();
      await pullAll();
      lastError = false;
      lastSyncedAt = now();
      await repo.setLastSyncedAt(userId, lastSyncedAt);
      await refreshPending();
    } catch {
      lastError = true;
      try {
        await refreshPending();
      } catch {
        // A failed count must not hide the sync error.
      }
    } finally {
      syncing = false;
    }
    publish();
  }

  async function pushAll(): Promise<void> {
    for (;;) {
      const rows = await dueOutbox(db, userId, now(), SYNC_PUSH_MAX_CHANGES);
      if (rows.length === 0) {
        return;
      }

      const changes: SyncPushChange[] = rows.map((row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        op: row.op,
        clientUpdatedAt: row.clientUpdatedAt,
        payload: row.payload,
      }));
      const result = await api.push(changes);
      const rowsByKey = groupRowsByKey(rows);
      const acknowledged = new Set<string>();
      let rejected = 0;

      for (const envelope of result.applied) {
        // The server clamps client clocks that run ahead, so the echo may be
        // older than the local row; force it in or `dirty` would never clear.
        const outcome = await repo.applyServerChange(userId, envelope, { force: true });
        for (const row of rowsByKey.get(syncKey(envelope.entityType, envelope.entityId)) ?? []) {
          acknowledged.add(row.id);
        }
        if (outcome === 'applied') {
          publish({ type: 'applied', entityType: envelope.entityType });
        } else {
          conflicts += 1;
          publish({ type: 'conflict', entityType: envelope.entityType });
        }
      }

      for (const key of result.skipped) {
        const skippedRows = rowsByKey.get(key) ?? [];
        for (const row of skippedRows) {
          acknowledged.add(row.id);
        }
        const entityType = skippedRows[0]?.entityType;
        if (entityType !== undefined) {
          conflicts += 1;
          publish({ type: 'conflict', entityType });
        }
      }

      for (const rejection of result.rejected) {
        for (const row of rowsByKey.get(rejection.key) ?? []) {
          acknowledged.add(row.id);
        }
        rejected += 1;
      }

      await acknowledgeOutbox(db, [...acknowledged]);
      if (rejected > 0) {
        await recordRejected(rejected);
      }
      if (acknowledged.size === 0) {
        // Nothing in the batch could be matched to a response; stop instead of
        // re-pushing the same rows forever.
        return;
      }
    }
  }

  async function pullAll(): Promise<void> {
    for (;;) {
      const since = await repo.getCursor(userId);
      const page = await api.pull(since);

      if (page.reset) {
        const snapshot = await api.snapshot();
        await repo.applySnapshot(userId, snapshot);
        await repo.setCursor(userId, snapshot.cursor);
        await refreshPending();
        publish();
        return;
      }

      let cursor = since;
      for (const change of page.changes) {
        const outcome = await repo.applyServerChange(userId, change);
        if (change.revision > cursor) {
          cursor = change.revision;
          await repo.setCursor(userId, cursor);
        }
        if (outcome === 'applied') {
          await refreshPending();
          publish({ type: 'applied', entityType: change.entityType });
        }
      }

      if (page.cursor > cursor) {
        cursor = page.cursor;
        await repo.setCursor(userId, cursor);
      }
      if (!page.hasMore) {
        return;
      }
    }
  }

  async function recordRejected(count: number): Promise<void> {
    const key = `${SYNC_ERRORS_PREFIX}${userId}`;
    const row = await db.meta.get(key);
    const previous = typeof row?.value === 'number' ? row.value : 0;
    await db.meta.put({ key, value: previous + count });
  }

  function groupRowsByKey(rows: OutboxRow[]): Map<string, OutboxRow[]> {
    const grouped = new Map<string, OutboxRow[]>();
    for (const row of rows) {
      const key = syncKey(row.entityType, row.entityId);
      const list = grouped.get(key);
      if (list === undefined) {
        grouped.set(key, [row]);
      } else {
        list.push(row);
      }
    }
    return grouped;
  }

  function syncNow(_reason?: string): Promise<void> {
    if (stopped) {
      return Promise.resolve();
    }
    if (running !== null) {
      rerunRequested = true;
      return running;
    }

    running = (async () => {
      do {
        rerunRequested = false;
        await runOnce();
      } while (rerunRequested && !stopped);
    })().finally(() => {
      running = null;
    });
    return running;
  }

  function handleStreamMessage(event: MessageEvent): void {
    // A delivered frame proves the stream is healthy; restart the backoff ladder.
    reconnectIndex = 0;
    void applyStreamChange(event);
  }

  async function applyStreamChange(event: MessageEvent): Promise<void> {
    let change: SyncChangeEnvelope;
    try {
      change = JSON.parse(String(event.data)) as SyncChangeEnvelope;
    } catch {
      return;
    }
    if (typeof change?.revision !== 'number') {
      return;
    }

    try {
      const outcome = await repo.applyServerChange(userId, change);
      const cursor = await repo.getCursor(userId);
      if (change.revision > cursor) {
        await repo.setCursor(userId, change.revision);
      }
      if (outcome === 'applied') {
        await refreshPending();
        publish({ type: 'applied', entityType: change.entityType });
      }
    } catch {
      // A dropped or malformed frame must not tear down the stream; the
      // heartbeat and the next pull will reconcile state.
    }
  }

  function handleStreamReset(): void {
    reconnectIndex = 0;
    void rebuildFromSnapshot();
  }

  async function rebuildFromSnapshot(): Promise<void> {
    try {
      const snapshot = await api.snapshot();
      await repo.applySnapshot(userId, snapshot);
      await repo.setCursor(userId, snapshot.cursor);
      await refreshPending();
      publish();
    } catch {
      // Leave the cursor untouched so the next sync retries the snapshot.
    }
  }

  function handleStreamError(): void {
    stream?.close();
    stream = null;
    scheduleReconnect();
  }

  function scheduleReconnect(): void {
    if (stopped || reconnectTimer !== null || !online()) {
      return;
    }

    const delay = RECONNECT_DELAYS[Math.min(reconnectIndex, RECONNECT_DELAYS.length - 1)];
    reconnectIndex += 1;
    reconnectTimer = setTimeout(() => {
      reconnectTimer = null;
      void connectStream();
    }, delay);
  }

  async function connectStream(): Promise<void> {
    if (stopped || !online() || eventSourceFactory === undefined || stream !== null) {
      return;
    }

    try {
      const { token } = await api.streamToken();
      if (stopped || !online() || eventSourceFactory === undefined || stream !== null) {
        return;
      }

      const since = await repo.getCursor(userId);
      const source = eventSourceFactory(syncStreamUrl(token, since));
      stream = source;
      source.addEventListener('message', handleStreamMessage);
      source.addEventListener('change', handleStreamMessage);
      source.addEventListener('reset', handleStreamReset);
      source.addEventListener('error', handleStreamError);
    } catch {
      scheduleReconnect();
    }
  }

  function teardownStream(): void {
    if (reconnectTimer !== null) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }
    if (stream !== null) {
      stream.close();
      stream = null;
    }
  }

  function stopListening(): void {
    heartbeatTimer = clearTimer(heartbeatTimer);
    if (onlineListener !== null && typeof window !== 'undefined') {
      window.removeEventListener('online', onlineListener);
      onlineListener = null;
    }
    if (visibilityListener !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityListener);
      visibilityListener = null;
    }
    teardownStream();
  }

  function start(): void {
    if (started || stopped) {
      return;
    }
    started = true;

    if (typeof window !== 'undefined') {
      onlineListener = () => {
        void syncNow('online');
        void connectStream();
      };
      window.addEventListener('online', onlineListener);
    }
    if (typeof document !== 'undefined') {
      visibilityListener = () => {
        if (document.visibilityState === 'visible') {
          void syncNow('visibility');
          void connectStream();
        }
      };
      document.addEventListener('visibilitychange', visibilityListener);
    }
    heartbeatTimer = setInterval(() => {
      void syncNow('heartbeat');
    }, HEARTBEAT_MS);

    void refreshState();
    void syncNow('start');
    void connectStream();
  }

  async function stop(): Promise<void> {
    stopped = true;
    started = false;
    stopListening();
    if (running !== null) {
      try {
        await running;
      } catch {
        // stop() never surfaces sync failures.
      }
    }
  }

  return {
    start,
    stop,
    syncNow,
    getState() {
      return { ...state };
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}

function clearTimer(timer: ReturnType<typeof setInterval> | null): null {
  if (timer !== null) {
    clearInterval(timer);
  }
  return null;
}
