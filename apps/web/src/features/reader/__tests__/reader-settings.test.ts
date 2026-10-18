import { beforeEach, expect, it } from 'vitest';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import { loadReaderSettings, saveReaderSettings, READER_SETTINGS_KEY } from '../readerSettings';

beforeEach(() => localStorage.clear());

it('returns defaults when nothing is stored or the payload is corrupt', () => {
  expect(loadReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
  localStorage.setItem(READER_SETTINGS_KEY, '{not json');
  expect(loadReaderSettings()).toEqual(DEFAULT_READER_SETTINGS);
});

it('round-trips a merged settings object', () => {
  saveReaderSettings({
    ...DEFAULT_READER_SETTINGS,
    theme: 'dark',
    epub: { ...DEFAULT_READER_SETTINGS.epub, fontSize: 24 },
  });
  expect(loadReaderSettings()).toMatchObject({ theme: 'dark', epub: { fontSize: 24 } });
});
