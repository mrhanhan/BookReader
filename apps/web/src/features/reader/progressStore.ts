import { locatorSchema } from '@bookr/shared';
import type { Locator } from '@bookr/shared';
import type { LocalRepository } from '../../sync/repository';

/**
 * Legacy localStorage entries, one per user and book. Positions now live in
 * Dexie; this prefix survives only so the first reader visit after the upgrade
 * can migrate the old cache into the local store.
 */
export const PROGRESS_KEY_PREFIX = 'bookr.reader.progress.';

export interface LocalProgress {
  locator: Locator;
  /** Epoch milliseconds of the local save. */
  savedAt: number;
}

/** Serialises with sorted keys, so equal locators compare equally. */
function stableJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`);
    return `{${entries.join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * Whether two positions point at the same place. The engine may hand back a
 * locator assembled in a different order, so keys are normalized first.
 */
export function locatorsEqual(left: Locator, right: Locator): boolean {
  return stableJson(left) === stableJson(right);
}

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage must not break reading or progress sync.
    return null;
  }
}

function keyFor(userId: string, bookId: string): string {
  return `${PROGRESS_KEY_PREFIX}${userId}.${bookId}`;
}

/**
 * Reads the legacy cache entry, treating corrupt data as "no cache". The same
 * key doubles as a synchronous last-position buffer: Dexie writes are async,
 * so `pagehide` cannot await them, but it can always flush this entry before
 * the page goes away.
 */
export function readLegacyProgress(userId: string, bookId: string): LocalProgress | null {
  const raw = storage()?.getItem(keyFor(userId, bookId));
  if (!raw) return null;

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }

  if (typeof parsed !== 'object' || parsed === null) return null;
  const record = parsed as { locator?: unknown; savedAt?: unknown };
  if (typeof record.savedAt !== 'number' || !Number.isFinite(record.savedAt)) return null;

  const locator = locatorSchema.safeParse(record.locator);
  if (!locator.success) return null;

  return { locator: locator.data, savedAt: record.savedAt };
}

/**
 * Writes the last-known position synchronously. `pagehide` and a crash can
 * tear the page down before an IndexedDB transaction commits, so this buffer
 * is the only write the reader can guarantee at that moment. Storage failures
 * are ignored: reading must continue even when the browser blocks storage.
 */
export function writeLegacyProgress(
  userId: string,
  bookId: string,
  locator: Locator,
  savedAt: number,
): void {
  const store = storage();
  if (!store) return;
  try {
    store.setItem(keyFor(userId, bookId), JSON.stringify({ locator, savedAt }));
  } catch {
    // Quota or a blocked storage; the Dexie write still runs.
  }
}

function forgetLegacyProgress(userId: string, bookId: string): void {
  try {
    storage()?.removeItem(keyFor(userId, bookId));
  } catch {
    // A blocked storage has nothing to forget.
  }
}

/** Epoch milliseconds of a row timestamp, or null when it is not parseable. */
function timeOf(clientUpdatedAt: string): number | null {
  const parsed = Date.parse(clientUpdatedAt);
  return Number.isNaN(parsed) ? null : parsed;
}

/**
 * Reads this device's cached position for one account.
 *
 * The Dexie row and the synchronous legacy buffer can disagree after a page
 * was closed mid-write, so the newer timestamp wins. When the buffer is newer
 * it is imported through the repository's conflict-aware apply path: the row
 * becomes `dirty: false` and no outbox entry is created, exactly like a
 * position pulled from another device. A row that was already aligned with
 * the server after the first pull keeps its newer timestamp and wins. The
 * legacy key is dropped once the comparison is settled so migration happens
 * once.
 */
export async function readLocalProgress(
  repo: LocalRepository,
  userId: string,
  bookId: string,
): Promise<LocalProgress | null> {
  const stored = await repo.progressFor(userId, bookId);
  const legacy = readLegacyProgress(userId, bookId);

  let current = stored;
  if (!current) {
    if (!legacy) {
      return null;
    }

    try {
      current = await repo.importProgress(userId, bookId, legacy.locator, legacy.savedAt);
    } catch {
      // Keeping the legacy entry lets the next visit retry the migration.
      return legacy;
    }
  }

  // `importProgress` may return a row a concurrent pull wrote first, so the
  // comparison runs on whatever the repository now holds. A row timestamp
  // aligned by the first pull is at least as new as the buffer and wins.
  const currentAt = timeOf(current.clientUpdatedAt);
  if (!legacy || (currentAt !== null && legacy.savedAt <= currentAt)) {
    if (legacy) {
      // The row is at least as new as the buffer, so the buffer is stale.
      forgetLegacyProgress(userId, bookId);
    }
    return { locator: current.locator, savedAt: currentAt ?? Date.now() };
  }

  const at = new Date(legacy.savedAt).toISOString();
  try {
    await repo.applyServerChange(userId, {
      revision: 0,
      entityType: 'reading_progress',
      entityId: bookId,
      op: 'upsert',
      payload: {
        bookId,
        locator: legacy.locator,
        percent: legacy.locator.percent,
        updatedAt: at,
        clientUpdatedAt: at,
      },
      clientUpdatedAt: at,
      serverUpdatedAt: at,
    });
    const merged = await repo.progressFor(userId, bookId);
    forgetLegacyProgress(userId, bookId);
    return merged
      ? { locator: merged.locator, savedAt: timeOf(merged.clientUpdatedAt) ?? legacy.savedAt }
      : legacy;
  } catch {
    // Keep the buffer for the next open and still open at its position.
    return legacy;
  }
}

/**
 * Saves locally and queues the change for sync. Resolves to whether the write
 * landed: the caller keeps the position dirty on failure so the next cycle
 * retries, and reading continues regardless.
 */
export async function writeLocalProgress(
  repo: LocalRepository,
  userId: string,
  bookId: string,
  locator: Locator,
  savedAt: number,
): Promise<boolean> {
  try {
    await repo.saveProgress(userId, bookId, locator, savedAt);
    return true;
  } catch {
    return false;
  }
}

/**
 * Drops every user's legacy localStorage position cache. Dexie rows are
 * namespaced by userId and are intentionally left in place (they may still
 * hold unsynced writes). The auth provider runs this when a session starts or
 * ends so a previous account's legacy entry cannot leak into the next.
 * A blocked storage must never break sign-in or sign-out.
 */
export function clearReaderProgressCache(): void {
  const store = storage();
  if (!store) return;
  try {
    const keys: string[] = [];
    for (let index = 0; index < store.length; index += 1) {
      const key = store.key(index);
      if (key !== null && key.startsWith(PROGRESS_KEY_PREFIX)) {
        keys.push(key);
      }
    }
    for (const key of keys) {
      store.removeItem(key);
    }
  } catch {
    // Blocked storage is already as private as it can get.
  }
}
