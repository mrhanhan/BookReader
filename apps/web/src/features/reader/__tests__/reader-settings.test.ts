import { beforeEach, expect, it } from 'vitest';
import { createElement } from 'react';
import { render, screen } from '@testing-library/react';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import { SettingsPanel } from '../SettingsPanel';
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
