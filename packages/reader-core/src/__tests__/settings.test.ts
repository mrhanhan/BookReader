import { describe, expect, it } from 'vitest';
import {
  DEFAULT_READER_SETTINGS,
  HIGHLIGHT_HEX,
  READER_THEME_COLORS,
  mergeReaderSettings,
} from '../settings';

describe('reader settings', () => {
  it('merges nested sections without losing sibling defaults', () => {
    const settings = mergeReaderSettings({ epub: { fontSize: 22 } });
    expect(settings.epub.fontSize).toBe(22);
    expect(settings.epub.lineHeight).toBe(1.8);
    expect(settings.pdf).toEqual(DEFAULT_READER_SETTINGS.pdf);
    expect(settings.pdf).toMatchObject({ crop: 'auto', cropAdjust: { top: 0, right: 0, bottom: 0, left: 0 } });
    expect(settings.theme).toBe('paper');
  });

  it('clamps values and ignores unknown enums', () => {
    const settings = mergeReaderSettings({
      brightness: 5, theme: 'neon',
      epub: { fontSize: 99, lineHeight: 0, margin: -4, flow: 'explode' },
      pdf: { zoom: 99, mode: 'flip', crop: 'sometimes', cropAdjust: { top: 99, right: -2, bottom: 3, left: 0 } },
    } as unknown);
    expect(settings.brightness).toBe(1.2);
    expect(settings.theme).toBe('paper');
    expect(settings.epub).toMatchObject({ fontSize: 28, lineHeight: 1.4, margin: 2, flow: 'paginated' });
    expect(settings.pdf).toMatchObject({ zoom: 4, mode: 'continuous', crop: 'auto' });
    expect(settings.pdf.cropAdjust).toEqual({ top: 10, right: 0, bottom: 3, left: 0 });
  });

  it('pins the exact default settings', () => {
    expect(DEFAULT_READER_SETTINGS).toEqual({
      theme: 'paper',
      brightness: 1,
      pdf: {
        mode: 'continuous',
        zoom: 'fit-width',
        crop: 'auto',
        cropAdjust: { top: 0, right: 0, bottom: 0, left: 0 },
        readingMode: 'original',
      },
      epub: {
        flow: 'paginated',
        fontFamily: 'serif',
        fontSize: 18,
        lineHeight: 1.8,
        margin: 6,
        spread: 'none',
      },
      reflow: { fontFamily: 'serif', fontSize: 19, lineHeight: 1.9, margin: 7 },
    });
    expect(mergeReaderSettings(undefined)).toEqual(DEFAULT_READER_SETTINGS);
    expect(Object.isFrozen(DEFAULT_READER_SETTINGS)).toBe(true);
    expect(Object.isFrozen(DEFAULT_READER_SETTINGS.pdf)).toBe(true);
    expect(Object.isFrozen(DEFAULT_READER_SETTINGS.pdf.cropAdjust)).toBe(true);
    expect(Object.isFrozen(DEFAULT_READER_SETTINGS.epub)).toBe(true);
    expect(Object.isFrozen(DEFAULT_READER_SETTINGS.reflow)).toBe(true);
  });

  it('pins the theme and highlight hex values', () => {
    expect(READER_THEME_COLORS).toEqual({
      paper: { background: '#F6F1E7', foreground: '#2B2620' },
      sepia: { background: '#F2E4C9', foreground: '#3A2E20' },
      green: { background: '#E4EBDD', foreground: '#2C3327' },
      dark: { background: '#1C1A17', foreground: '#E6DECF' },
    });
    expect(HIGHLIGHT_HEX).toEqual({
      yellow: '#E8C56B',
      green: '#9BBF8A',
      blue: '#8FB4C9',
      pink: '#D9A6A0',
      purple: '#B3A0C6',
    });
  });

  it('never throws on arbitrary input and falls back per field', () => {
    const garbage: unknown[] = [
      null,
      undefined,
      42,
      'nope',
      [],
      { brightness: Number.NaN },
      { pdf: null, epub: 'nope' },
      { pdf: [], epub: [] },
      { pdf: { zoom: Number.POSITIVE_INFINITY, cropAdjust: 'nope' } },
      { epub: { fontSize: '22', lineHeight: null, margin: {} } },
    ];

    for (const value of garbage) {
      expect(() => mergeReaderSettings(value)).not.toThrow();
    }

    expect(mergeReaderSettings({ brightness: Number.NaN }).brightness).toBe(1);
    expect(mergeReaderSettings({ pdf: { zoom: Number.POSITIVE_INFINITY } }).pdf.zoom).toBe('fit-width');
    expect(mergeReaderSettings({ pdf: { zoom: 'fit-page' } }).pdf.zoom).toBe('fit-page');
    expect(mergeReaderSettings({ epub: { spread: 'auto', fontFamily: 'sans' } }).epub)
      .toMatchObject({ spread: 'auto', fontFamily: 'sans' });
  });

  it('clamps fit ranges at both ends', () => {
    const settings = mergeReaderSettings({
      brightness: 0.1,
      pdf: { zoom: 0.1, cropAdjust: { top: -1, right: 11, bottom: 5.5, left: 0 } },
      epub: { fontSize: 1, lineHeight: 9, margin: 99 },
      reflow: { fontSize: 1, lineHeight: 9, margin: 99 },
    });
    expect(settings.brightness).toBe(0.6);
    expect(settings.pdf.zoom).toBe(0.5);
    expect(settings.pdf.cropAdjust).toEqual({ top: 0, right: 10, bottom: 5.5, left: 0 });
    expect(settings.epub).toMatchObject({ fontSize: 14, lineHeight: 2.4, margin: 12 });
    expect(settings.reflow).toEqual({ fontFamily: 'serif', fontSize: 16, lineHeight: 2.4, margin: 16 });
  });

  it('defaults to original mode and clamps reflow settings', () => {
    const defaults = mergeReaderSettings({});
    expect(defaults.pdf.readingMode).toBe('original');
    expect(defaults.reflow).toEqual({ fontFamily: 'serif', fontSize: 19, lineHeight: 1.9, margin: 7 });

    const clamped = mergeReaderSettings({
      pdf: { readingMode: 'nonsense' },
      reflow: { fontFamily: 'mono', fontSize: 99, lineHeight: 0.2, margin: -4 },
    });
    expect(clamped.pdf.readingMode).toBe('original');
    expect(clamped.reflow).toEqual({ fontFamily: 'serif', fontSize: 28, lineHeight: 1.5, margin: 2 });
  });

  it('keeps each mode when explicitly selected and ignores garbage reflow input', () => {
    expect(mergeReaderSettings({ pdf: { readingMode: 'reflow' } }).pdf.readingMode).toBe('reflow');
    expect(mergeReaderSettings({ pdf: { readingMode: 'original' } }).pdf.readingMode).toBe('original');
    expect(mergeReaderSettings({ reflow: { fontFamily: 'sans' } }).reflow).toEqual({
      fontFamily: 'sans',
      fontSize: 19,
      lineHeight: 1.9,
      margin: 7,
    });
    expect(mergeReaderSettings({ reflow: 'nope' }).reflow).toEqual(DEFAULT_READER_SETTINGS.reflow);
    expect(mergeReaderSettings({ reflow: { fontSize: Number.NaN, margin: {} } }).reflow).toEqual(
      DEFAULT_READER_SETTINGS.reflow,
    );
  });
});
