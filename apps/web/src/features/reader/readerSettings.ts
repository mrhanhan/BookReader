import { DEFAULT_READER_SETTINGS, mergeReaderSettings } from '@bookr/reader-core';
import type { ReaderSettings } from '@bookr/reader-core';
import type { LocalSettingsRow } from '../../sync/types';

/**
 * Pre-sync global key. Settings are now one document per account in the local
 * repository; this key is read once so the first reader visit after the
 * upgrade can migrate the old preference into that account.
 */
export const READER_SETTINGS_KEY = 'bookr.reader.settings.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage (private mode, sandboxed iframe) behaves like no settings.
    return null;
  }
}

/**
 * Reads the legacy global settings, if any. `null` means there is nothing to
 * migrate; corrupt payloads are dropped instead of blocking the account's
 * settings row.
 */
export function readLegacyReaderSettings(): ReaderSettings | null {
  const store = storage();
  const raw = store?.getItem(READER_SETTINGS_KEY);
  if (!raw) return null;

  try {
    return mergeReaderSettings(JSON.parse(raw));
  } catch {
    clearLegacyReaderSettings();
    return null;
  }
}

/** Drops the migrated global entry; later opens only read the account row. */
export function clearLegacyReaderSettings(): void {
  try {
    storage()?.removeItem(READER_SETTINGS_KEY);
  } catch {
    // A blocked store has nothing to clear.
  }
}

/**
 * Merges a repository row over the defaults. A missing row (a new account, or
 * one that never changed a setting) still yields fresh defaults instead of a
 * previous account's values.
 */
export function readerSettingsFromRow(
  row: LocalSettingsRow | null | undefined,
): ReaderSettings {
  return row ? mergeReaderSettings(row.settings) : mergeReaderSettings(DEFAULT_READER_SETTINGS);
}
