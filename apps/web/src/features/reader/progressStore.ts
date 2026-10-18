import { locatorSchema } from '@bookr/shared';
import type { Locator, ReadingProgressDto } from '@bookr/shared';
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

/** Reads the pre-Dexie cache entry, treating corrupt data as "no cache". */
function readLegacyProgress(userId: string, bookId: string): LocalProgress | null {
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
 * Reads this device's cached position for one account. A position that only
 * exists in the old localStorage cache is migrated into Dexie without creating
 * a sync entry, then the legacy key is dropped so migration happens once.
 */
export async function readLocalProgress(
  repo: LocalRepository,
  userId: string,
  bookId: string,
): Promise<LocalProgress | null> {
  const stored = await repo.progressFor(userId, bookId);
  if (stored) {
    const savedAt = Date.parse(stored.clientUpdatedAt);
    return { locator: stored.locator, savedAt: Number.isNaN(savedAt) ? Date.now() : savedAt };
  }

  const legacy = readLegacyProgress(userId, bookId);
  if (!legacy) {
    return null;
  }

  try {
    await repo.importProgress(userId, bookId, legacy.locator, legacy.savedAt);
    storage()?.removeItem(keyFor(userId, bookId));
  } catch {
    // Keeping the legacy entry lets the next visit retry the migration.
    return legacy;
  }
  return legacy;
}

/** Saves locally and queues the change for sync; failures never block reading. */
export function writeLocalProgress(
  repo: LocalRepository,
  userId: string,
  bookId: string,
  locator: Locator,
  savedAt: number,
): void {
  void repo.saveProgress(userId, bookId, locator, savedAt).catch(() => {
    // The next throttled write retries; reading continues regardless.
  });
}

/**
 * Drops every user's legacy cached position. The auth provider runs this when
 * a session starts or ends so one account's position cannot leak into the next.
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

/**
 * Picks where the reader should open when both a server position and a legacy
 * cache entry exist. Kept for the upgrade path and unit tests.
 */
export function resolveInitialLocator(
  server: ReadingProgressDto | null,
  local: LocalProgress | null,
): Locator | undefined {
  if (server && local) {
    const serverSavedAt = Date.parse(server.updatedAt);
    return local.savedAt > serverSavedAt ? local.locator : server.locator;
  }
  if (server) return server.locator;
  if (local) return local.locator;
  return undefined;
}
