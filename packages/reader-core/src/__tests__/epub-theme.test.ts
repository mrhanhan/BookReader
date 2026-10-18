import { expect, it } from 'vitest';
import { mergeReaderSettings, DEFAULT_READER_SETTINGS } from '../settings';
import { epubOverrides, epubThemeCss } from '../epub/theme';

it('paints each paper-ink theme inside the epub iframe', () => {
  expect(epubThemeCss('paper')).toContain('background: #F6F1E7');
  expect(epubThemeCss('dark')).toContain('color: #E6DECF');
});

it('maps typography settings to epub overrides', () => {
  const settings = mergeReaderSettings({ epub: { fontSize: 22, lineHeight: 2, margin: 8 } });
  const overrides = Object.fromEntries(epubOverrides(settings));
  expect(overrides['font-size']).toBe('22px');
  expect(overrides['line-height']).toBe('2');
  expect(overrides['padding-left']).toBe('8%');
  expect(overrides['padding-right']).toBe('8%');
  expect(epubOverrides(DEFAULT_READER_SETTINGS).length).toBeGreaterThan(3);
});
