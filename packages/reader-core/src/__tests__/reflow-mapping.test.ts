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
        blocks: [
          paragraph('p1-b0', 0, 40, 0.1),
          { id: 'p1-img', type: 'image', rect: { x: 0.1, y: 0.3, w: 0.8, h: 0.12 } },
          paragraph('p1-b1', 40, 90, 0.55),
        ],
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
    expect(index.page(1)?.blocks).toHaveLength(3);
    expect(index.page(2)?.blocks).toEqual([]);
    expect(index.page(9)).toBeNull();
    expect(index.block('p1-b1')).toMatchObject({ block: { id: 'p1-b1' }, page: { page: 1 } });
    expect(index.block('p1-img')).toMatchObject({ block: { id: 'p1-img' }, page: { page: 1 } });
    expect(index.block('missing')).toBeNull();
    expect(index.textBlocksOnPage(1).map((block) => block.id)).toEqual(['p1-b0', 'p1-b1']);
    expect(index.firstTextBlock(1)?.id).toBe('p1-b0');
    expect(index.firstTextBlock(2)).toBeNull();
    expect(index.toc()).toEqual(pack.toc);
  });
});

describe('reflow locator mapping', () => {
  it('prefers the PDF rect over charOffset and keeps caret positions out', () => {
    const mapped = reflowLocatorFor(
      {
        kind: 'pdf',
        page: 1,
        percent: 0.2,
        // The rect sits on p1-b1 while the offset points at p1-b0.
        rect: { x: 0.1, y: 0.62, w: 0.8, h: 0.02 },
        charOffset: 10,
      },
      pack,
    );
    expect(mapped).toMatchObject({ kind: 'reflow', sourcePage: 1, blockId: 'p1-b1', percent: 0.2 });
    expect(mapped?.charRange).toBeUndefined();
  });

  it('lets visual blocks win rect matching but never text fallbacks', () => {
    const overImage = reflowLocatorFor(
      { kind: 'pdf', page: 1, percent: 0.3, rect: { x: 0.1, y: 0.33, w: 0.8, h: 0.02 } },
      pack,
    );
    expect(overImage?.blockId).toBe('p1-img');
    expect(reflowLocatorFor({ kind: 'pdf', page: 1, percent: 0.1 }, pack)?.blockId).toBe('p1-b0');
    expect(new ReflowPackIndex(pack).textBlocksOnPage(1).map((block) => block.id)).toEqual([
      'p1-b0',
      'p1-b1',
    ]);
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

  it('uses the nearest source start for an out-of-range charOffset', () => {
    expect(reflowLocatorFor({ kind: 'pdf', page: 1, percent: 0.1, charOffset: 1000 }, pack)?.blockId).toBe(
      'p1-b1',
    );
  });

  it('clamps page zero to page one in both directions', () => {
    expect(reflowLocatorFor({ kind: 'pdf', page: 0, percent: 0.1 }, pack)).toMatchObject({
      kind: 'reflow',
      sourcePage: 1,
    });
    expect(pdfLocatorFor({ kind: 'reflow', sourcePage: 0, percent: 0.1 }, pack)).toEqual({
      kind: 'pdf',
      page: 1,
      percent: 0.1,
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

  it('keeps the block rect without a charOffset when the block has no source start', () => {
    const withoutOffsets = JSON.parse(JSON.stringify(pack)) as ReflowPack;
    const block = withoutOffsets.pages[0]!.blocks.find((candidate) => candidate.id === 'p1-b1')!;
    delete block.sourceCharStart;
    delete block.sourceCharEnd;

    const mapped = pdfLocatorFor(
      { kind: 'reflow', sourcePage: 1, percent: 0.2, blockId: 'p1-b1', charRange: [3, 9] },
      withoutOffsets,
    );
    expect(mapped).toMatchObject({ kind: 'pdf', page: 1, percent: 0.2 });
    expect(mapped?.rect).toEqual({ x: 0.1, y: 0.55, w: 0.8, h: 0.08 });
    expect(mapped?.charOffset).toBeUndefined();
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

  it('resolves blocks only on the locator source page', () => {
    expect(
      pdfLocatorFor({ kind: 'reflow', sourcePage: 2, percent: 0.4, blockId: 'p1-b0' }, pack),
    ).toEqual({ kind: 'pdf', page: 2, percent: 0.4 });
    expect(
      pdfLocatorFor({ kind: 'reflow', sourcePage: 1, percent: 0.4, blockId: 'missing' }, pack),
    ).toEqual({ kind: 'pdf', page: 1, percent: 0.4 });
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

  it('returns fresh normalized copies in reflow mode without a pack', () => {
    const pdf = { kind: 'pdf' as const, page: 7, percent: 0.3 };
    const copiedPdf = locatorForMode(pdf, 'reflow');
    expect(copiedPdf).not.toBe(pdf);
    expect(copiedPdf).toEqual(pdf);

    const reflow = {
      kind: 'reflow' as const,
      sourcePage: 0,
      percent: Number.NaN,
      ranges: [{ blockId: 'p1-b0', charRange: [0, 2] as [number, number] }],
    };
    const copiedReflow = locatorForMode(reflow, 'reflow');
    expect(copiedReflow).not.toBe(reflow);
    expect(copiedReflow).toMatchObject({ kind: 'reflow', sourcePage: 1, percent: 0 });
    if (copiedReflow?.kind !== 'reflow') {
      throw new Error('expected a reflow locator');
    }
    expect(copiedReflow.ranges).not.toBe(reflow.ranges);
    expect(copiedReflow.ranges).toEqual(reflow.ranges);
  });

  it('treats a non-finite page count as unbounded instead of producing NaN', () => {
    const brokenCount = {
      ...pack,
      source: { ...pack.source, pageCount: Number.NaN },
    } as ReflowPack;
    const mapped = pdfLocatorFor({ kind: 'reflow', sourcePage: 7, percent: 0.3 }, brokenCount);
    expect(mapped).toEqual({ kind: 'pdf', page: 7, percent: 0.3 });
    expect(Number.isFinite(mapped?.page)).toBe(true);
    expect(reflowLocatorFor({ kind: 'pdf', page: 7, percent: 0.3 }, brokenCount)?.sourcePage).toBe(7);
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

  it('returns null for EPUB, unknown kinds and malformed input', () => {
    const epub = { kind: 'epub' as const, cfi: 'epubcfi(/6/4!/4)', percent: 0.3 };
    const unknown = { kind: 'foo', page: 1, percent: 0.2 } as unknown as Parameters<
      typeof reflowLocatorFor
    >[0];
    expect(reflowLocatorFor(epub, pack)).toBeNull();
    expect(pdfLocatorFor(epub, pack)).toBeNull();
    expect(reflowLocatorFor(unknown, pack)).toBeNull();
    expect(pdfLocatorFor(unknown, pack)).toBeNull();
    expect(locatorForMode(unknown, 'reflow', pack)).toBeNull();
    expect(locatorForMode(unknown, 'original', pack)).toBeNull();
    expect(reflowLocatorFor(null as unknown as Parameters<typeof reflowLocatorFor>[0], pack)).toBeNull();
    expect(pdfLocatorFor({ kind: 'pdf', page: Number.NaN, percent: Number.NaN }, pack)).toMatchObject({
      kind: 'pdf',
      page: 1,
    });
  });
});
