import { describe, expect, it } from 'vitest';
import { locatorSchema, readerKindForFormat, unionRects } from '../locators';

describe('locator contract', () => {
  it('accepts the three documented locator shapes', () => {
    expect(locatorSchema.safeParse({ kind: 'pdf', page: 1, percent: 0 }).success).toBe(true);
    expect(locatorSchema.safeParse({ kind: 'epub', cfi: 'epubcfi(/6/4!/2)', percent: 0.6 }).success).toBe(true);
    expect(locatorSchema.safeParse({
      kind: 'reflow', sourcePage: 3, blockId: 'b_1', charRange: [2, 8], percent: 0.2,
    }).success).toBe(true);
  });

  it('rejects impossible positions', () => {
    expect(locatorSchema.safeParse({ kind: 'pdf', page: 0, percent: 0 }).success).toBe(false);
    expect(locatorSchema.safeParse({ kind: 'pdf', page: 1, percent: 1.2 }).success).toBe(false);
    expect(locatorSchema.safeParse({
      kind: 'pdf', page: 1, percent: 0.2,
      rect: { x: 0.9, y: 0.1, w: 0.2, h: 0.1 },
    }).success).toBe(false);
    expect(locatorSchema.safeParse({ kind: 'epub', cfi: '', percent: 0 }).success).toBe(false);
    expect(locatorSchema.safeParse({
      kind: 'reflow', sourcePage: 1, charRange: [9, 2], percent: 0.1,
    }).success).toBe(false);
  });

  it('maps every book format to the engine that actually reads it', () => {
    expect(readerKindForFormat('pdf')).toBe('pdf');
    expect(readerKindForFormat('epub')).toBe('epub');
    expect(readerKindForFormat('mobi')).toBe('epub');
    expect(readerKindForFormat('azw3')).toBe('epub');
  });

  it('unions highlight rectangles into one bounding rect', () => {
    expect(unionRects([
      { x: 0.1, y: 0.2, w: 0.3, h: 0.05 },
      { x: 0.2, y: 0.4, w: 0.4, h: 0.1 },
    ])).toEqual({ x: 0.1, y: 0.2, w: 0.5, h: 0.3 });
  });
});
