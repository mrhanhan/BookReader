import { locatorSchema } from '@bookr/shared';
import type { Locator, ReadingProgressDto } from '@bookr/shared';

/** One localStorage entry per book, holding the last position seen on this device. */
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

function keyFor(bookId: string): string {
  return `${PROGRESS_KEY_PREFIX}${bookId}`;
}

/**
 * Reads this device's cached position. Corrupt JSON and unknown shapes are
 * treated as "no cache" rather than throwing at the reader.
 */
export function readLocalProgress(bookId: string): LocalProgress | null {
  const raw = storage()?.getItem(keyFor(bookId));
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
export function writeLocalProgress(bookId: string, locator: Locator, savedAt: number): void {
  try {
    storage()?.setItem(keyFor(bookId), JSON.stringify({ locator, savedAt }));
  } catch {
    // Reading must continue even when the cache cannot be written.
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
