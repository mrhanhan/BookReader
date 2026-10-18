import { SYNC_PUSH_MAX_CHANGES, syncKey } from '@bookr/shared';
import type {
  SyncChangeEnvelope,
  SyncEntityType,
  SyncPushChange,
  SyncPushResult,
} from '@bookr/shared';
import { ApiError } from '../api/client';
import { syncStreamUrl } from '../api/sync';
import type { SyncApi } from '../api/sync';
import type { BookrDb } from './db';
import { acknowledgeOutbox, dueOutbox } from './outbox';
import type { OutboxRow } from './types';
import type { LocalRepository } from './repository';

export type SyncStatus = 'synced' | 'syncing' | 'pending' | 'offline' | 'error';

/** Where an applied server change came from; a push echo is our own write. */
export type AppliedSource = 'push' | 'pull' | 'stream';

/**
 * Diagnostic record of the latest server change written to the local store.
 * Nothing consumes it for navigation: the reader aligns progress once when it
 * opens instead of following changes live.
 */
export interface AppliedChange {
  entityType: SyncEntityType;
  entityId: string;
  /** Engine clock at application time; only meaningful as an ordering marker. */
  at: number;
  source: AppliedSource;
}

/** The latest server-vs-local conflict the engine resolved. */
export interface ConflictNotice {
  entityType: SyncEntityType;
  entityId: string;
  /** Engine clock at resolution time; only meaningful as an ordering marker. */
  at: number;
}

export interface SyncState {
  status: SyncStatus;
  pending: number;
  lastSyncedAt: number | null;
  conflicts: number;
  /**
   * Diagnostic marker for the latest applied change; retained for status and
   * debugging only, not for driving any view.
   */
  lastApplied?: AppliedChange;
  /** Set when the engine resolves a conflict, so views can describe it. */
  lastConflict?: ConflictNotice;
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
const BOOTSTRAP_PREFIX = 'bootstrapped:';
const SNAPSHOT_DEFERRED_PREFIX = 'snapshotDeferred:';
/** Snapshot attempts postponed for pending writes before one is forced. */
const MAX_SNAPSHOT_DEFERRALS = 5;
/** A deferral record older than this forces the next snapshot. */
const SNAPSHOT_DEFER_WINDOW_MS = 5 * 60 * 1000;
/** Upper bound for the exponential push retry delay. */
const MAX_PUSH_BACKOFF_MS = 5 * 60 * 1000;

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
  let lastConflict: ConflictNotice | undefined;
  /**
   * Set by the browser's `offline` event until `online` fires. It overrides the
   * injectable probe so an explicit event always wins over a stale value.
   */
  let offlineNotified = false;
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
  let offlineListener: (() => void) | null = null;
  let visibilityListener: (() => void) | null = null;

  const listeners = new Set<(state: SyncState) => void>();

  /** Effective connectivity: an explicit offline event beats the probe. */
  function canReachNetwork(): boolean {
    return !offlineNotified && online();
  }

  function computeState(): SyncState {
    let status: SyncStatus;
    if (!canReachNetwork()) {
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
    return { status, pending, lastSyncedAt, conflicts, lastApplied, lastConflict };
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
    } else if (event?.type === 'conflict') {
      lastConflict = { entityType: event.entityType, entityId: event.entityId, at: now() };
    }

    const next = computeState();
    const changed =
      next.status !== state.status ||
      next.pending !== state.pending ||
      next.lastSyncedAt !== state.lastSyncedAt ||
      next.conflicts !== state.conflicts ||
      next.lastApplied !== state.lastApplied ||
      next.lastConflict !== state.lastConflict;
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

  /**
   * Serializes local application of server state. Stream frames and pulls run
   * through one queue so an older revision cannot overwrite a newer one, and
   * the cursor can only move forward.
   */
  function enqueueSerial<T>(task: () => Promise<T>): Promise<T> {
    const result = streamQueue.then(task);
    streamQueue = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }

  /** Push every due batch, then pull pages until the server reports the end. */
  async function runOnce(): Promise<void> {
    if (!canReachNetwork()) {
      await refreshPending();
      publish();
      return;
    }

    syncing = true;
    publish();
    try {
      const bootstrapped = await bootstrapIfNeeded();
      if (!bootstrapped) {
        await pushAll();
      }
      await enqueueSerial(() => pullAll());
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

  /**
   * A device that has never synced holds cursor 0, but the server does not
   * reset its log for every new client. Push the local outbox first, then take
   * a full snapshot so the existing server state lands locally. The marker
   * keeps this one-shot even when the server has no changes and the snapshot
   * cursor stays at 0.
   *
   * Returns true when it ran the outbox push itself, so the caller does not
   * repeat it in the same sync.
   */
  async function bootstrapIfNeeded(): Promise<boolean> {
    const key = `${BOOTSTRAP_PREFIX}${userId}`;
    if ((await db.meta.get(key)) !== undefined) {
      return false;
    }

    if ((await repo.getCursor(userId)) !== 0) {
      await db.meta.put({ key, value: true });
      return false;
    }

    await pushAll();
    if (await shouldDeferSnapshot()) {
      // A write the server never acknowledged would be erased by the
      // snapshot; leave the bootstrap for the next sync instead. The deferral
      // counter bounds how long that can last.
      return true;
    }

    await enqueueSerial(async () => {
      const snapshot = await api.snapshot();
      await repo.applySnapshot(userId, snapshot);
      await repo.setCursor(userId, snapshot.cursor);
    });
    await db.meta.put({ key, value: true });
    await refreshPending();
    publish();
    return true;
  }

  /**
   * Whether a snapshot must wait for queued writes. Deferrals are counted per
   * user and bounded by both a count and a time window, so a write that cannot
   * be pushed (for example while permanently rejected by the server) cannot
   * keep the local store stale forever. The outbox itself is never cleared by
   * a snapshot, so the pending payload survives for the next push.
   */
  async function shouldDeferSnapshot(): Promise<boolean> {
    const key = `${SNAPSHOT_DEFERRED_PREFIX}${userId}`;
    if ((await repo.pendingCount(userId)) === 0) {
      await db.meta.delete(key);
      return false;
    }

    return db.transaction('rw', db.meta, async () => {
      const record = readSnapshotDeferral((await db.meta.get(key))?.value);
      const count = (record?.count ?? 0) + 1;
      const since = record?.since ?? now();
      if (count >= MAX_SNAPSHOT_DEFERRALS || now() - since >= SNAPSHOT_DEFER_WINDOW_MS) {
        await db.meta.delete(key);
        return false;
      }
      await db.meta.put({ key, value: { count, since } });
      return true;
    });
  }

  async function pushAll(): Promise<void> {
    for (;;) {
      const rows = await dueOutbox(db, userId, now(), SYNC_PUSH_MAX_CHANGES);
      if (rows.length === 0) {
        return;
      }

      const acknowledged = await pushBatch(rows);
      if (acknowledged === 0) {
        // Nothing in the batch could be matched to a response; stop instead of
        // re-pushing the same rows forever.
        return;
      }
    }
  }

  /**
   * Pushes one batch and applies its result. A 413 means the request was too
   * large: halve the batch and retry each half, down to a single row, which is
   * dropped and counted as rejected. Other failures back the rows off.
   */
  async function pushBatch(rows: OutboxRow[]): Promise<number> {
    if (rows.length === 0) {
      return 0;
    }

    let result: SyncPushResult;
    try {
      const changes: SyncPushChange[] = rows.map((row) => ({
        entityType: row.entityType,
        entityId: row.entityId,
        op: row.op,
        clientUpdatedAt: row.clientUpdatedAt,
        payload: row.payload,
      }));
      result = await api.push(changes);
    } catch (error) {
      if (error instanceof ApiError && error.status === 413) {
        if (rows.length > 1) {
          const cut = Math.ceil(rows.length / 2);
          const first = await pushBatch(rows.slice(0, cut));
          const second = await pushBatch(rows.slice(cut));
          return first + second;
        }
        await acknowledgeOutbox(db, rows);
        await recordRejected(1);
        return rows.length;
      }

      await backOffBatch(rows);
      throw error;
    }

    return applyPushResult(rows, result);
  }

  /** Exponential backoff so a failing push does not block the sync loop. */
  async function backOffBatch(rows: OutboxRow[]): Promise<void> {
    await db.transaction('rw', db.outbox, async () => {
      for (const row of rows) {
        const current = await db.outbox.get(row.id);
        if (current === undefined) {
          continue;
        }
        const attempts = current.attempts + 1;
        const delay = Math.min(2 ** attempts * 1000, MAX_PUSH_BACKOFF_MS);
        await db.outbox.update(row.id, {
          attempts,
          nextAttemptAt: now() + delay,
        });
      }
    });
  }

  /** Acknowledges what the server settled and applies its echoes. */
  async function applyPushResult(rows: OutboxRow[], result: SyncPushResult): Promise<number> {
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
      // Echoes share the serial queue with pull and stream application, so a
      // response cannot interleave with a newer frame. A frame may already
      // have moved past this echo while the push was in flight; replaying the
      // older payload would undo it, so only clear the local dirty flag.
      const applied = await enqueueSerial(async () => {
        if (envelope.revision <= (await repo.getCursor(userId))) {
          await markLocalClean(envelope.entityType, envelope.entityId);
          return false;
        }
        return (await repo.applyServerChange(userId, envelope)) === 'applied';
      });
      if (applied) {
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

    return acknowledged.size;
  }

  async function pullAll(): Promise<void> {
    for (;;) {
      const since = await repo.getCursor(userId);
      const page = await api.pull(since);

      if (page.reset) {
        // A snapshot replaces every local row. While queued writes remain
        // (possibly backing off) it would hide them from the UI, so postpone
        // it: the next sync pushes first and retries the snapshot. The
        // deferral counter forces one eventually.
        if (await shouldDeferSnapshot()) {
          return;
        }
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
        // Revisions are the global log order: anything at or below the running
        // cursor is a duplicate or an out-of-order frame and must not overwrite
        // newer local state.
        if (change.revision <= cursor) {
          continue;
        }
        const outcome = await repo.applyServerChange(userId, change);
        cursor = change.revision;
        await repo.setCursor(userId, cursor);
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
    // A host may never deliver the `online` event (embedded WebViews, some
    // proxies). Trust the connectivity probe on the next requested sync so
    // the engine does not stay offline until a reload.
    if (offlineNotified && online()) {
      offlineNotified = false;
      void connectStream();
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
    void enqueueSerial(() => applyStreamChange(event)).catch(() => undefined);
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
    void enqueueSerial(() => rebuildFromSnapshot()).catch(() => undefined);
  }

  async function rebuildFromSnapshot(): Promise<void> {
    if (stopped) {
      return;
    }
    try {
      if (await shouldDeferSnapshot()) {
        // Keep queued local rows visible; the next sync pushes them before it
        // retries the rebuild. The deferral counter forces one eventually.
        return;
      }
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
    if (stopped || reconnectTimer !== null || !canReachNetwork()) {
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
    if (
      stopped ||
      !canReachNetwork() ||
      eventSourceFactory === undefined ||
      stream !== null ||
      connecting
    ) {
      return;
    }

    connecting = true;
    try {
      const { token } = await api.streamToken();
      if (stopped || !canReachNetwork() || eventSourceFactory === undefined || stream !== null) {
        return;
      }

      const since = await repo.getCursor(userId);
      if (stopped || !canReachNetwork()) {
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
    if (offlineListener !== null && typeof window !== 'undefined') {
      window.removeEventListener('offline', offlineListener);
      offlineListener = null;
    }
    if (visibilityListener !== null && typeof document !== 'undefined') {
      document.removeEventListener('visibilitychange', visibilityListener);
      visibilityListener = null;
    }
    teardownStream();
  }

  function handleOffline(): void {
    if (stopped) {
      return;
    }
    offlineNotified = true;
    reconnectIndex = 0;
    teardownStream();
    publish();
  }

  function handleOnline(): void {
    if (stopped) {
      return;
    }
    offlineNotified = false;
    void syncNow('online');
    void connectStream();
  }

  function start(): void {
    if (started || stopped) {
      return;
    }
    started = true;

    if (typeof window !== 'undefined') {
      onlineListener = handleOnline;
      offlineListener = handleOffline;
      window.addEventListener('online', onlineListener);
      window.addEventListener('offline', offlineListener);
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

/** Reads the persisted snapshot-deferral counter; malformed values start over. */
function readSnapshotDeferral(value: unknown): { count: number; since: number } | null {
  if (typeof value !== 'object' || value === null) {
    return null;
  }
  const record = value as { count?: unknown; since?: unknown };
  return typeof record.count === 'number' && typeof record.since === 'number'
    ? { count: record.count, since: record.since }
    : null;
}
