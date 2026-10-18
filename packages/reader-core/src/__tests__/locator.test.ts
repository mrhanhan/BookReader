import { describe, expect, it } from 'vitest';
import { clamp, isEpubLocator, isPdfLocator, normalizeRect, pageForPercent, percentForPage } from '../locator';

describe('reader locator math', () => {
  it('converts a page position to a 0–1 percentage', () => {
    expect(percentForPage(1, 10)).toBe(0);
    expect(percentForPage(10, 10)).toBe(0.9);
    expect(percentForPage(5, 10, 0.5)).toBe(0.45);
    expect(percentForPage(99, 10)).toBe(0.9);
  });

  it('converts a percentage back to a page', () => {
    expect(pageForPercent(0, 10)).toBe(1);
    expect(pageForPercent(0.45, 10)).toBe(5);
    expect(pageForPercent(1, 10)).toBe(10);
  });

  it('normalizes client rects against the page box and clamps overflow', () => {
    const bounds = { left: 100, top: 50, width: 200, height: 400 };
    expect(normalizeRect({ left: 120, top: 70, width: 20, height: 40 }, bounds))
      .toEqual({ x: 0.1, y: 0.05, w: 0.1, h: 0.1 });
    expect(normalizeRect({ left: 290, top: 440, width: 40, height: 40 }, bounds))
      .toEqual({ x: 0.95, y: 0.975, w: 0.05, h: 0.025 });
  });

  it('rounds every coordinate to six decimals and never exceeds the page', () => {
    const bounds = { left: 0, top: 0, width: 3, height: 3 };
    expect(normalizeRect({ left: 1, top: 1, width: 1, height: 1 }, bounds))
      .toEqual({ x: 0.333333, y: 0.333333, w: 0.333333, h: 0.333333 });
    expect(normalizeRect({ left: -10, top: -10, width: 100, height: 100 }, bounds))
      .toEqual({ x: 0, y: 0, w: 1, h: 1 });

    const narrow = { left: 0, top: 0, width: 7, height: 7 };
    const rect = normalizeRect({ left: 5, top: 5, width: 2, height: 2 }, narrow);
    expect(rect.x + rect.w).toBeLessThanOrEqual(1);
    expect(rect.y + rect.h).toBeLessThanOrEqual(1);
  });

  it('clamps values into a range', () => {
    expect(clamp(5, 0, 1)).toBe(1);
    expect(clamp(-1, 0, 1)).toBe(0);
    expect(clamp(0.5, 0, 1)).toBe(0.5);
  });

  it('distinguishes PDF and EPUB locators', () => {
    expect(isPdfLocator({ kind: 'pdf', page: 1, percent: 0 })).toBe(true);
    expect(isEpubLocator({ kind: 'pdf', page: 1, percent: 0 })).toBe(false);
    expect(isEpubLocator({ kind: 'epub', cfi: 'epubcfi(/6/4!/2)', percent: 0 })).toBe(true);
    expect(isPdfLocator({ kind: 'epub', cfi: 'epubcfi(/6/4!/2)', percent: 0 })).toBe(false);
    expect(isPdfLocator({ kind: 'reflow', sourcePage: 1, percent: 0 })).toBe(false);
    expect(isEpubLocator({ kind: 'reflow', sourcePage: 1, percent: 0 })).toBe(false);
  });
});
