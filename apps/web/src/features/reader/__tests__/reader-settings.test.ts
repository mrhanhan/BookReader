import { beforeEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import { SettingsPanel } from '../SettingsPanel';
import {
  READER_SETTINGS_KEY,
  clearLegacyReaderSettings,
  readLegacyReaderSettings,
  readerSettingsFromRow,
} from '../readerSettings';
import type { LocalSettingsRow } from '../../../sync/types';

beforeEach(() => localStorage.clear());

function settingsRow(settings: Record<string, unknown>): LocalSettingsRow {
  return {
    userId: 'user-reader',
    settings,
    clientUpdatedAt: '2026-05-01T00:00:00.000Z',
    dirty: false,
  };
}

it('returns null when nothing was stored or the payload is corrupt', () => {
  expect(readLegacyReaderSettings()).toBeNull();

  localStorage.setItem(READER_SETTINGS_KEY, '{not json');
  expect(readLegacyReaderSettings()).toBeNull();
  // The unusable entry is dropped so it cannot shadow the account row forever.
  expect(localStorage.getItem(READER_SETTINGS_KEY)).toBeNull();
});

it('round-trips legacy settings through the merge', () => {
  localStorage.setItem(
    READER_SETTINGS_KEY,
    JSON.stringify({ theme: 'dark', epub: { fontSize: 24 } }),
  );

  expect(readLegacyReaderSettings()).toMatchObject({
    theme: 'dark',
    epub: { fontSize: 24 },
  });
});

it('clears the migrated legacy entry', () => {
  localStorage.setItem(READER_SETTINGS_KEY, JSON.stringify({ theme: 'sepia' }));
  clearLegacyReaderSettings();
  expect(localStorage.getItem(READER_SETTINGS_KEY)).toBeNull();
});

it('merges a repository row over the defaults', () => {
  expect(readerSettingsFromRow(null)).toEqual(DEFAULT_READER_SETTINGS);
  expect(readerSettingsFromRow(settingsRow({ theme: 'green', brightness: 0.8 }))).toMatchObject({
    theme: 'green',
    brightness: 0.8,
    // Fields the row does not carry keep their defaults.
    pdf: DEFAULT_READER_SETTINGS.pdf,
  });
});

it('shows reflow typography only for the reflow kind', () => {
  const view = render(
    createElement(SettingsPanel, {
      kind: 'reflow',
      settings: DEFAULT_READER_SETTINGS,
      onChange: () => {},
      onClose: () => {},
    }),
  );

  expect(screen.getByLabelText('字体')).toBeInTheDocument();
  expect(screen.getByLabelText('字号')).toBeInTheDocument();
  expect(screen.getByLabelText('行距')).toBeInTheDocument();
  expect(screen.getByLabelText('页边距')).toBeInTheDocument();
  // Theme and brightness stay available in every mode.
  expect(screen.getByLabelText('亮度')).toBeInTheDocument();
  view.unmount();

  render(
    createElement(SettingsPanel, {
      kind: 'pdf',
      settings: DEFAULT_READER_SETTINGS,
      onChange: () => {},
      onClose: () => {},
    }),
  );
  expect(screen.queryByLabelText('字号')).toBeNull();
  expect(screen.queryByLabelText('行距')).toBeNull();
  expect(screen.queryByLabelText('页边距')).toBeNull();
});
