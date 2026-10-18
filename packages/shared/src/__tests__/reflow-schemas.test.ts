import { describe, expect, it } from 'vitest';
import {
  MAX_REFLOW_BLOCKS,
  MAX_REFLOW_BLOCKS_PER_PAGE,
  MAX_REFLOW_PAGES,
  MAX_REFLOW_TEXT_LENGTH,
  REFLOW_PACK_SCHEMA_VERSION,
  reflowPackSchema,
} from '../schemas/reflow';
import golden from './fixtures/golden.bookr.json';

function pack(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: REFLOW_PACK_SCHEMA_VERSION,
    source: { sha256: 'a'.repeat(64), pageCount: 2 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '0.1.0' },
    quality: { pages: 2, textBlocks: 2, fallbackPages: [], ocrPages: [], avgConfidence: null, warnings: [] },
    toc: [{ label: '第一章', page: 1, level: 1 }],
    pages: [
      { page: 1, width: 612, height: 792, blocks: [
        { id: 'p1-b0', type: 'heading', text: '第一章', level: 1, rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.05 }, sourceCharStart: 0, sourceCharEnd: 3 },
        { id: 'p1-b1', type: 'paragraph', text: '正文。', rect: { x: 0.1, y: 0.2, w: 0.8, h: 0.05 }, sourceCharStart: 4, sourceCharEnd: 7 },
      ] },
      { page: 2, width: 612, height: 792, blocks: [
        { id: 'p2-b0', type: 'fallback', rect: { x: 0, y: 0, w: 1, h: 1 } },
      ] },
    ],
    ...overrides,
  };
}

describe('reflowPackSchema', () => {
  it('accepts the golden pack and a valid synthetic pack', () => {
    expect(reflowPackSchema.safeParse(golden).success).toBe(true);
    expect(reflowPackSchema.safeParse(pack()).success).toBe(true);
  });

  it('requires pageCount to equal pages.length and pages to be 1..n', () => {
    expect(reflowPackSchema.safeParse(pack({ source: { sha256: 'a'.repeat(64), pageCount: 3 } })).success).toBe(false);
    const reversed = pack();
    reversed.pages = [reversed.pages[1]!, reversed.pages[0]!];
    expect(reflowPackSchema.safeParse(reversed).success).toBe(false);
  });

  it('rejects out-of-range rects, duplicate ids, missing text and unknown block types', () => {
    const badRect = pack();
    badRect.pages[0]!.blocks[0]!.rect = { x: 0.9, y: 0.1, w: 0.2, h: 0.05 };
    expect(reflowPackSchema.safeParse(badRect).success).toBe(false);

    const duplicate = pack();
    duplicate.pages[0]!.blocks[1]!.id = 'p1-b0';
    expect(reflowPackSchema.safeParse(duplicate).success).toBe(false);

    const noText = pack();
    // @ts-expect-error deliberately invalid: paragraph blocks require text
    noText.pages[0]!.blocks[1]!.text = undefined;
    expect(reflowPackSchema.safeParse(noText).success).toBe(false);

    const unknown = pack();
    // Deliberately invalid at runtime; the inferred block type is widened to string.
    unknown.pages[0]!.blocks[0]!.type = 'script';
    expect(reflowPackSchema.safeParse(unknown).success).toBe(false);
  });

  it('accepts exactly the per-page block cap and rejects one more', () => {
    const atLimit = pack();
    atLimit.pages[0]!.blocks = Array.from({ length: MAX_REFLOW_BLOCKS_PER_PAGE }, (_, index) => ({
      id: `b${index}`, type: 'paragraph', text: 'x', rect: { x: 0, y: 0, w: 1, h: 1 },
    }));
    expect(reflowPackSchema.safeParse(atLimit).success).toBe(true);

    const overLimit = pack();
    overLimit.pages[0]!.blocks = Array.from({ length: MAX_REFLOW_BLOCKS_PER_PAGE + 1 }, (_, index) => ({
      id: `b${index}`, type: 'paragraph', text: 'x', rect: { x: 0, y: 0, w: 1, h: 1 },
    }));
    expect(reflowPackSchema.safeParse(overLimit).success).toBe(false);

    expect(reflowPackSchema.safeParse(pack({ schemaVersion: 2 })).success).toBe(false);
  });

  it('rejects a heading without a level, inverted source offsets and oversized text', () => {
    const noLevel = pack();
    // @ts-expect-error deliberately invalid: heading blocks require a level
    noLevel.pages[0]!.blocks[0]!.level = undefined;
    expect(reflowPackSchema.safeParse(noLevel).success).toBe(false);

    const invertedOffsets = pack();
    (invertedOffsets.pages[0]!.blocks[1] as { sourceCharEnd: number }).sourceCharEnd = 1;
    expect(reflowPackSchema.safeParse(invertedOffsets).success).toBe(false);

    const oversized = pack();
    (oversized.pages[0]!.blocks[1] as { text?: string }).text = 'x'.repeat(
      MAX_REFLOW_TEXT_LENGTH + 1,
    );
    expect(reflowPackSchema.safeParse(oversized).success).toBe(false);
  });

  it('caps total blocks and only accepts UTC timestamps', () => {
    expect(41 * MAX_REFLOW_PAGES).toBeGreaterThan(MAX_REFLOW_BLOCKS);

    const tooMany = pack({
      source: { sha256: 'a'.repeat(64), pageCount: MAX_REFLOW_PAGES },
      pages: Array.from({ length: MAX_REFLOW_PAGES }, (_, pageIndex) => ({
        page: pageIndex + 1,
        width: 612,
        height: 792,
        blocks: Array.from({ length: 41 }, (_, blockIndex) => ({
          id: `p${pageIndex}-b${blockIndex}`,
          type: 'paragraph',
          text: 'x',
          rect: { x: 0, y: 0, w: 1, h: 1 },
        })),
      })),
    });
    expect(reflowPackSchema.safeParse(tooMany).success).toBe(false);

    const offsetTimestamp = pack({ generatedAt: '2026-10-18T08:00:00.000+00:00' });
    expect(reflowPackSchema.safeParse(offsetTimestamp).success).toBe(false);
  });
});
