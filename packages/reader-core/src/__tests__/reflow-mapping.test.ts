import type { ReflowBlock, ReflowPack } from '@bookr/shared';
import { describe, expect, it } from 'vitest';
import { locatorForMode, pdfLocatorFor, reflowLocatorFor } from '../reflow/mapping';
import { ReflowPackIndex, indexReflowPack } from '../reflow/pack';

function paragraph(
  id: string,
  sourceCharStart: number,
  sourceCharEnd: number,
  y: number,
): ReflowBlock {
  return {
    id,
    type: 'paragraph',
    text: 'x'.repeat(sourceCharEnd - sourceCharStart),
    rect: { x: 0.1, y, w: 0.8, h: 0.08 },
    sourceCharStart,
    sourceCharEnd,
  };
}

function makePack(): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'a'.repeat(64), pageCount: 3 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: 3,
      textBlocks: 3,
      fallbackPages: [2],
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [{ label: '第一章', page: 1, level: 1 }],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        blocks: [paragraph('p1-b0', 0, 40, 0.1), paragraph('p1-b1', 40, 90, 0.55)],
      },
      { page: 2, width: 600, height: 800, blocks: [] },
      { page: 3, width: 600, height: 800, blocks: [paragraph('p3-b0', 20, 30, 0.2)] },
    ],
  };
}

const pack = makePack();

describe('reflow pack index', () => {
  it('rejects invalid packs with a stable message', () => {
    expect(() => indexReflowPack({ schemaVersion: 99 })).toThrow('Invalid reflow pack');
    expect(() => indexReflowPack(null)).toThrow('Invalid reflow pack');
    expect(indexReflowPack(pack)).toEqual(pack);
  });

  it('indexes pages, blocks and text blocks', () => {
    const index = new ReflowPackIndex(pack);
    expect(index.pageCount).toBe(3);
    expect(index.page(1)?.blocks).toHaveLength(2);
    expect(index.page(2)?.blocks).toEqual([]);
    expect(index.page(9)).toBeNull();
    expect(index.block('p1-b1')).toMatchObject({ block: { id: 'p1-b1' }, page: { page: 1 } });
    expect(index.block('missing')).toBeNull();
    expect(index.textBlocksOnPage(1).map((block) => block.id)).toEqual(['p1-b0', 'p1-b1']);
    expect(index.firstTextBlock(1)?.id).toBe('p1-b0');
    expect(index.firstTextBlock(2)).toBeNull();
    expect(index.toc()).toEqual(pack.toc);
  });
});

describe('reflow locator mapping', () => {
  it('maps a PDF rect to the block at the same height, then to a caret position', () => {
    const mapped = reflowLocatorFor(
      {
        kind: 'pdf',
        page: 1,
        percent: 0.2,
        rect: { x: 0.1, y: 0.62, w: 0.8, h: 0.02 },
        charOffset: 120,
      },
      pack,
    );
    expect(mapped).toMatchObject({ kind: 'reflow', sourcePage: 1, blockId: 'p1-b1', percent: 0.2 });
    expect(mapped?.charRange).toBeUndefined();
  });

  it('falls back to charOffset, then the first text block, then the page', () => {
    expect(reflowLocatorFor({ kind: 'pdf', page: 1, percent: 0.1, charOffset: 44 }, pack)?.blockId).toBe('p1-b1');
    expect(reflowLocatorFor({ kind: 'pdf', page: 1, percent: 0.1 }, pack)?.blockId).toBe('p1-b0');
    expect(reflowLocatorFor({ kind: 'pdf', page: 2, percent: 0.4 }, pack)).toEqual({
      kind: 'reflow',
      sourcePage: 2,
      percent: 0.4,
    });
  });

  it('maps reflow back to the same source page with rect and charOffset', () => {
    const mapped = pdfLocatorFor(
      { kind: 'reflow', sourcePage: 1, percent: 0.2, blockId: 'p1-b1', charRange: [3, 9] },
      pack,
    );
    expect(mapped).toMatchObject({ kind: 'pdf', page: 1, percent: 0.2, charOffset: 43 });
    expect(mapped?.rect).toEqual({ x: 0.1, y: 0.55, w: 0.8, h: 0.08 });
  });

  it('keeps the source page when a reflow locator has no block or a stale block id', () => {
    expect(pdfLocatorFor({ kind: 'reflow', sourcePage: 2, percent: 0.4 }, pack)).toEqual({
      kind: 'pdf',
      page: 2,
      percent: 0.4,
    });
    expect(pdfLocatorFor({ kind: 'reflow', sourcePage: 99, percent: 0.9 }, pack)).toEqual({
      kind: 'pdf',
      page: 3,
      percent: 0.9,
    });
  });

  it('normalizes without a pack in both directions', () => {
    expect(locatorForMode({ kind: 'reflow', sourcePage: 7, percent: 0.3 }, 'original')).toEqual({
      kind: 'pdf',
      page: 7,
      percent: 0.3,
    });
    expect(locatorForMode({ kind: 'pdf', page: 7, percent: 0.3 }, 'reflow')).toEqual({
      kind: 'pdf',
      page: 7,
      percent: 0.3,
    });
    expect(locatorForMode({ kind: 'epub', cfi: 'epubcfi(/6/4!/4)', percent: 0.3 }, 'reflow')).toBeNull();
  });

  it('preserves an existing reflow locator including cross-block ranges', () => {
    const locator = {
      kind: 'reflow' as const,
      sourcePage: 99,
      percent: 0.5,
      blockId: 'p1-b0',
      charRange: [0, 3] as [number, number],
      ranges: [{ blockId: 'p1-b1', charRange: [0, 2] as [number, number] }],
    };
    expect(reflowLocatorFor(locator, pack)).toMatchObject({
      sourcePage: 3,
      blockId: 'p1-b0',
      charRange: [0, 3],
      ranges: [{ blockId: 'p1-b1', charRange: [0, 2] }],
    });
  });

  it('returns null for EPUB locators and never throws on malformed input', () => {
    const epub = { kind: 'epub' as const, cfi: 'epubcfi(/6/4!/4)', percent: 0.3 };
    expect(reflowLocatorFor(epub, pack)).toBeNull();
    expect(pdfLocatorFor(epub, pack)).toBeNull();
    expect(reflowLocatorFor(null as unknown as Parameters<typeof reflowLocatorFor>[0], pack)).toBeNull();
    expect(pdfLocatorFor({ kind: 'pdf', page: Number.NaN, percent: Number.NaN }, pack)).toMatchObject({
      kind: 'pdf',
      page: 1,
    });
  });
});
