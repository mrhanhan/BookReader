import type { ReflowPack } from '@bookr/shared';
import { expect, it } from 'vitest';
import { indexForPack } from '../reflow/pack';
import {
  capContextText,
  epubTextFromDocument,
  normalizeContextText,
  pdfChapterRange,
  pdfPageText,
  reflowChapterText,
} from '../text-context';

function pack(): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'a'.repeat(64), pageCount: 2 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: 2, textBlocks: 4, fallbackPages: [], ocrPages: [],
      avgConfidence: null, warnings: [],
    },
    toc: [],
    pages: [
      {
        page: 1, width: 600, height: 800,
        blocks: [
          { id: 'h1', type: 'heading', level: 1, text: '第一章', rect: { x: 0, y: 0, w: 1, h: 0.1 } },
          { id: 'p1', type: 'paragraph', text: '第一章正文', rect: { x: 0, y: 0.1, w: 1, h: 0.1 } },
        ],
      },
      {
        page: 2, width: 600, height: 800,
        blocks: [
          { id: 'h2', type: 'heading', level: 1, text: '第二章', rect: { x: 0, y: 0, w: 1, h: 0.1 } },
          { id: 'p2', type: 'paragraph', text: '第二章正文', rect: { x: 0, y: 0.1, w: 1, h: 0.1 } },
        ],
      },
    ],
  };
}

it('normalizes whitespace and caps text', () => {
  expect(normalizeContextText('  第一段\n\n\n\n第二段  ')).toBe('第一段\n\n第二段');
  expect(capContextText('abcdef', 3)).toEqual({ text: 'abc…', truncated: true });
  expect(capContextText('abc', 3)).toEqual({ text: 'abc', truncated: false });
  expect(capContextText('abc', 0)).toEqual({ text: '', truncated: true });
});

it('joins PDF text items with line breaks and spaces', () => {
  expect(pdfPageText([
    { str: 'Hello' }, { str: 'world' }, { str: 'next line', hasEOL: true }, { str: 'end' },
  ])).toBe('Hello world next line\nend');
});

it('computes a chapter range from the outline', () => {
  expect(pdfChapterRange(5, [1, 4, 9], 20)).toEqual({ start: 4, end: 8 });
  expect(pdfChapterRange(5, [], 20)).toEqual({ start: 5, end: 20 });
  expect(pdfChapterRange(1, [1, 4], 20)).toEqual({ start: 1, end: 3 });
  // Page 18 is still inside the chapter that starts on page 4.
  expect(pdfChapterRange(18, [1, 4], 20)).toEqual({ start: 4, end: 20 });
});

it('extracts EPUB chapter text from a document', () => {
  const document = new DOMParser().parseFromString(
    '<html><body><p>第一段</p><p>第二段</p></body></html>',
    'text/html',
  );
  expect(epubTextFromDocument(document)).toContain('第一段');
});

it('collects reflow text from the current heading to the next one', () => {
  const result = reflowChapterText(indexForPack(pack()), 1, 'p1', 10_000);
  expect(result.label).toBe('第一章');
  expect(result.text).toContain('第一章正文');
  expect(result.text).not.toContain('第二章正文');

  const capped = reflowChapterText(indexForPack(pack()), 1, 'p1', 3);
  expect(capped.truncated).toBe(true);
});
