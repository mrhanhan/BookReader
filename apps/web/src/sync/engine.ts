import { SYNC_PUSH_MAX_CHANGES, syncKey } from '@bookr/shared';
import type { SyncChangeEnvelope, SyncEntityType, SyncPushChange } from '@bookr/shared';
import { syncStreamUrl } from '../api/sync';
import type { SyncApi } from '../api/sync';
import type { BookrDb } from './db';
import { acknowledgeOutbox, dueOutbox } from './outbox';
import type { OutboxRow } from './types';
import type { LocalRepository } from './repository';

export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error';

/** Where an applied server change came from; a push echo is our own write. */
export type AppliedSource = 'push' | 'pull' | 'stream';

/** The latest server change written to the local store. */
export interface AppliedChange {
  entityType: SyncEntityType;
  entityId: string;
  /** Engine clock at application time; only meaningful as an ordering marker. */
  at: number;
  source: AppliedSource;
}

export interface SyncState {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: number | null;
  conflicts: number;
  /**
   * Set when the engine applies a server change to the local store. Open views
   * (the reader's progress) compare this to what they already followed.
   */
  lastApplied?: AppliedChange;
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
  entityId: string;
  source?: AppliedSource;
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
  let lastApplied: AppliedChange | undefined;
  /** Bumped whenever pending/lastSyncedAt are written, so a stale refresh cannot win. */
  let stateEpoch = 0;

  let running: Promise<void> | null = null;
  let rerunRequested = false;

  let stream: EventSourceLike | null = null;
  let connecting = false;
  let streamQueue: Promise<void> = Promise.resolve();
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
    return { status, pending, lastSyncedAt, conflicts, lastApplied };
  }

  let state = computeState();

  function publish(event?: SyncEvent): void {
    if (event?.type === 'applied') {
      lastApplied = {
        entityType: event.entityType,
        entityId: event.entityId,
        at: now(),
        source: event.source ?? 'pull',
      };
    }

    const next = computeState();
    const changed =
      next.status !== state.status ||
      next.pending !== state.pending ||
      next.lastSyncedAt !== state.lastSyncedAt ||
      next.conflicts !== state.conflicts ||
      next.lastApplied !== state.lastApplied;
    state = next;
    if (!changed && event === undefined) {
      return;
    }

    for (const listener of listeners) {
      listener(state);
    }
    // `onChange` consumers only care about the kind of change; the entity id
    // and source stay on the published state.
    const notice =
      event === undefined ? undefined : { type: event.type, entityType: event.entityType };
    onChange?.(state, notice);
  }

  async function refreshPending(): Promise<void> {
    pending = await repo.pendingCount(userId);
    stateEpoch += 1;
  }

  /**
   * Loads persisted state, but only when nothing newer has written these fields
   * while the reads were in flight (`start()` races the first sync).
   */
  async function refreshState(): Promise<void> {
    const epoch = stateEpoch;
    const [pendingValue, lastValue] = await Promise.all([
      repo.pendingCount(userId),
      repo.getLastSyncedAt(userId),
    ]);
    if (epoch !== stateEpoch) {
      return;
    }
    pending = pendingValue;
    lastSyncedAt = lastValue;
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
      stateEpoch += 1;
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
      // Ids alone are not enough: a merged progress row may have changed while
      // the batch was in flight, and acknowledging it would drop the newer
      // position. Keep the snapshot so only unchanged rows are removed.
      const acknowledged = new Map<string, OutboxRow>();
      const skippedKeys: string[] = [];
      let rejected = 0;

      for (const envelope of result.applied) {
        for (const row of rowsByKey.get(syncKey(envelope.entityType, envelope.entityId)) ?? []) {
          acknowledged.set(row.id, row);
        }
      }

      for (const key of result.skipped) {
        skippedKeys.push(key);
        for (const row of rowsByKey.get(key) ?? []) {
          acknowledged.set(row.id, row);
        }
      }

      for (const rejection of result.rejected) {
        for (const row of rowsByKey.get(rejection.key) ?? []) {
          acknowledged.set(row.id, row);
        }
        rejected += 1;
      }

      // Confirm the batch *before* applying the echoes. Writes made while the
      // push was in flight are still queued, so last-write-wins protects them;
      // if nothing newer was written, the echo applies because no pending row
      // is left to compare against.
      await acknowledgeOutbox(db, [...acknowledged.values()]);
      if (rejected > 0) {
        await recordRejected(rejected);
      }

      for (const envelope of result.applied) {
        const outcome = await repo.applyServerChange(userId, envelope);
        if (outcome === 'applied') {
          publish({
            type: 'applied',
            entityType: envelope.entityType,
            entityId: envelope.entityId,
            source: 'push',
          });
        }
      }

      for (const key of skippedKeys) {
        const skippedRows = rowsByKey.get(key) ?? [];
        const first = skippedRows[0];
        if (first === undefined) {
          continue;
        }
        conflicts += 1;
        await markLocalClean(first.entityType, first.entityId);
        publish({ type: 'conflict', entityType: first.entityType, entityId: first.entityId });
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

      if (page.changes.length === 0) {
        // No progress: advance to the head only when the server says the log is
        // complete, otherwise return instead of spinning on the same page.
        if (!page.hasMore && page.cursor > since) {
          await repo.setCursor(userId, page.cursor);
        }
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
          publish({
            type: 'applied',
            entityType: change.entityType,
            entityId: change.entityId,
            source: 'pull',
          });
        }
      }

      if (cursor <= since) {
        return;
      }

      if (!page.hasMore) {
        // Only the final page may jump to the log head: with more pages the
        // server cursor is ahead of this page and would skip its remaining rows.
        if (page.cursor > cursor) {
          await repo.setCursor(userId, page.cursor);
        }
        return;
      }
    }
  }

  async function hasPendingRows(entityType: SyncEntityType, entityId: string): Promise<boolean> {
    const count = await db.outbox
      .where('userId')
      .equals(userId)
      .filter((row) => row.entityType === entityType && row.entityId === entityId)
      .count();
    return count > 0;
  }

  /** A server-skipped push leaves no work behind, so its local row is clean. */
  async function markLocalClean(entityType: SyncEntityType, entityId: string): Promise<void> {
    if (await hasPendingRows(entityType, entityId)) {
      return;
    }

    switch (entityType) {
      case 'reading_progress': {
        const row = await db.progress.get([userId, entityId]);
        if (row?.dirty === true && row.userId === userId) {
          await db.progress.update([userId, entityId], { dirty: false });
        }
        return;
      }
      case 'annotation': {
        const row = await db.annotations.get(entityId);
        if (row?.dirty === true && row.userId === userId) {
          await db.annotations.update(entityId, { dirty: false });
        }
        return;
      }
      case 'bookmark': {
        const row = await db.bookmarks.get(entityId);
        if (row?.dirty === true && row.userId === userId) {
          await db.bookmarks.update(entityId, { dirty: false });
        }
        return;
      }
      case 'reader_settings': {
        const row = await db.settings.get(userId);
        if (row?.dirty === true) {
          await db.settings.update(userId, { dirty: false });
        }
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

  function handleStreamOpen(): void {
    reconnectIndex = 0;
  }

  function handleStreamMessage(event: MessageEvent): void {
    if (stopped) {
      return;
    }
    // A delivered frame proves the stream is healthy; restart the backoff ladder.
    reconnectIndex = 0;
    streamQueue = streamQueue.then(() => applyStreamChange(event)).catch(() => undefined);
  }

  async function applyStreamChange(event: MessageEvent): Promise<void> {
    if (stopped) {
      return;
    }

    let change: SyncChangeEnvelope;
    try {
      change = JSON.parse(String(event.data)) as SyncChangeEnvelope;
    } catch {
      return;
    }
    if (typeof change?.revision !== 'number' || typeof change.entityType !== 'string') {
      return;
    }

    try {
      const cursor = await repo.getCursor(userId);
      if (stopped || change.revision <= cursor) {
        return;
      }

      const outcome = await repo.applyServerChange(userId, change);
      if (stopped) {
        return;
      }
      if (change.revision > (await repo.getCursor(userId))) {
        await repo.setCursor(userId, change.revision);
      }
      if (outcome === 'applied') {
        await refreshPending();
        if (stopped) {
          return;
        }
        publish({
          type: 'applied',
          entityType: change.entityType,
          entityId: change.entityId,
          source: 'stream',
        });
      }
    } catch {
      // A dropped or malformed frame must not tear down the stream; the
      // heartbeat and the next pull will reconcile state.
    }
  }

  function handleStreamReset(): void {
    if (stopped) {
      return;
    }
    reconnectIndex = 0;
    streamQueue = streamQueue.then(() => rebuildFromSnapshot()).catch(() => undefined);
  }

  async function rebuildFromSnapshot(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      const snapshot = await api.snapshot();
      if (stopped) {
        return;
      }
      await repo.applySnapshot(userId, snapshot);
      if (stopped) {
        return;
      }
      await repo.setCursor(userId, snapshot.cursor);
      await refreshPending();
      if (stopped) {
        return;
      }
      publish();
    } catch {
      // Leave the cursor untouched so the next sync retries the snapshot.
    }
  }

  function handleStreamError(): void {
    if (stopped) {
      return;
    }
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
    if (stopped || !online() || eventSourceFactory === undefined || stream !== null || connecting) {
      return;
    }

    connecting = true;
    try {
      const { token } = await api.streamToken();
      if (stopped || !online() || eventSourceFactory === undefined || stream !== null) {
        return;
      }

      const since = await repo.getCursor(userId);
      if (stopped || !online()) {
        return;
      }

      const source = eventSourceFactory(syncStreamUrl(token, since));
      stream = source;
      source.addEventListener('open', handleStreamOpen);
      source.addEventListener('message', handleStreamMessage);
      source.addEventListener('change', handleStreamMessage);
      source.addEventListener('reset', handleStreamReset);
      source.addEventListener('error', handleStreamError);
    } catch {
      if (!stopped) {
        scheduleReconnect();
      }
    } finally {
      connecting = false;
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
