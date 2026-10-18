import { locatorSchema } from '@bookr/shared';
import type { Locator, ReadingProgressDto } from '@bookr/shared';

/**
 * One localStorage entry per user and book, holding the last position seen on
 * this device. The user id is part of the key: several accounts share one
 * browser and must never read or overwrite each other's position.
 */
export const PROGRESS_KEY_PREFIX = 'bookr.reader.progress.';

export interface LocalProgress {
  locator: Locator;
  /** Epoch milliseconds, compared against the server's `updatedAt`. */
  savedAt: number;
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
 * Reads this device's cached position for one account. Corrupt JSON and
 * unknown shapes are treated as "no cache" rather than throwing at the reader.
 */
export function readLocalProgress(userId: string, bookId: string): LocalProgress | null {
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

/** Caches a position locally; failures (quota, blocked storage) are swallowed. */
export function writeLocalProgress(
  userId: string,
  bookId: string,
  locator: Locator,
  savedAt: number,
): void {
  try {
    storage()?.setItem(keyFor(userId, bookId), JSON.stringify({ locator, savedAt }));
  } catch {
    // Reading must continue even when the cache cannot be written.
  }
}

/**
 * Drops every user's cached position. The auth provider runs this when a
 * session starts or ends so one account's position cannot leak into the next.
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
 * Picks where the reader should open. The newest of the server position and
 * this device's cache wins; a server position without local progress always
 * wins over nothing, and vice versa.
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
