import { DEFAULT_READER_SETTINGS, mergeReaderSettings } from '@bookr/reader-core';
import type { ReaderSettings } from '@bookr/reader-core';

/** Persisted reading preferences; exported so tests and migrations agree. */
export const READER_SETTINGS_KEY = 'bookr.reader.settings.v1';

function storage(): Storage | null {
  try {
    return typeof localStorage === 'undefined' ? null : localStorage;
  } catch {
    // Blocked storage (private mode, sandboxed iframe) behaves like no settings.
    return null;
  }
}

/** Reads persisted settings, falling back to the defaults for any bad payload. */
export function loadReaderSettings(): ReaderSettings {
  const raw = storage()?.getItem(READER_SETTINGS_KEY);
  if (!raw) {
    return mergeReaderSettings(DEFAULT_READER_SETTINGS);
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return mergeReaderSettings(DEFAULT_READER_SETTINGS);
  }
  return mergeReaderSettings(parsed);
}

/** Merges and clamps settings before writing, so a bad caller cannot persist junk. */
export function saveReaderSettings(settings: ReaderSettings): void {
  try {
    storage()?.setItem(READER_SETTINGS_KEY, JSON.stringify(mergeReaderSettings(settings)));
  } catch {
    // Quota or a blocked store must never break reading.
  }
}
