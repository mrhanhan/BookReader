import type { ReflowBlock } from '@bookr/shared';

import type { ReflowPackIndex } from './reflow/pack';

/** Upper bound used when a caller does not ask for a specific character cap. */
export const DEFAULT_CONTEXT_MAX_CHARS = 20_000;

/** Pages scanned for a PDF chapter when the outline has no following entry. */
const PDF_CHAPTER_PAGE_SPAN = 20;
const PAGE_SEPARATOR = '\n\n';

function safeLimit(maxChars: number): number {
  if (!Number.isFinite(maxChars)) {
    return 0;
  }
  return Math.max(0, Math.floor(maxChars));
}

/**
 * Collapses the whitespace that PDF/EPUB extraction duplicates (non-breaking
 * spaces, blank runs, trailing spaces) without touching the single spaces that
 * belong between words.
 */
export function normalizeContextText(text: string): string {
  return text
    .replace(/\r\n?/g, '\n')
    .replace(/ /g, ' ')
    .replace(/[ \t]+$/gm, '')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

/**
 * Cuts text down to `maxChars` code units. The ellipsis is appended after the
 * cap, so the result is never longer than `maxChars + 1`.
 */
export function capContextText(
  text: string,
  maxChars: number,
): { text: string; truncated: boolean } {
  const limit = safeLimit(maxChars);
  if (limit <= 0) {
    return { text: '', truncated: true };
  }
  if (text.length <= limit) {
    return { text, truncated: false };
  }
  return { text: `${text.slice(0, limit)}…`, truncated: true };
}

/** Rebuilds page text from pdf.js text items, preserving line breaks. */
export function pdfPageText(items: Array<{ str?: string; hasEOL?: boolean }>): string {
  let text = '';
  for (const item of items) {
    text += item.str ?? '';
    text += item.hasEOL ? '\n' : ' ';
  }
  return normalizeContextText(text);
}

/**
 * Derives the page range of the chapter that contains `currentPage`, using the
 * pages of the PDF outline. A chapter ends just before the next outline entry;
 * without one, the scan is capped at 20 pages.
 */
export function pdfChapterRange(
  currentPage: number,
  tocPages: number[],
  pageCount: number,
): { start: number; end: number } {
  const count = Number.isFinite(pageCount) ? Math.max(1, Math.floor(pageCount)) : 1;
  const current = Number.isFinite(currentPage) ? Math.floor(currentPage) : 1;

  const pages = [
    ...new Set(
      tocPages
        .filter((page) => Number.isFinite(page))
        .map((page) => Math.floor(page))
        .filter((page) => page >= 1 && page <= count),
    ),
  ].sort((left, right) => left - right);

  const previous = pages.filter((page) => page <= current).at(-1);
  const next = pages.find((page) => page > current);
  const start = Math.min(Math.max(previous ?? current, 1), count);
  const rawEnd = next === undefined
    ? Math.min(count, start + PDF_CHAPTER_PAGE_SPAN - 1)
    : next - 1;
  const end = Math.min(Math.max(rawEnd, start), count);

  return { start, end };
}

/** Reads the visible chapter HTML as plain text; a missing document is empty. */
export function epubTextFromDocument(document: Document | null): string {
  const body = document?.body ?? null;
  const raw = body?.innerText ?? body?.textContent ?? '';
  return normalizeContextText(raw);
}

interface FlattenedTextBlock {
  block: ReflowBlock;
  page: number;
}

function flattenTextBlocks(index: ReflowPackIndex): FlattenedTextBlock[] {
  const blocks: FlattenedTextBlock[] = [];
  for (const page of index.pack.pages) {
    for (const block of index.textBlocksOnPage(page.page)) {
      blocks.push({ block, page: page.page });
    }
  }
  return blocks;
}

/**
 * Finds the current block: the exact `(sourcePage, blockId)` pair when it still
 * exists, otherwise the first text block of the current page.
 */
function currentBlockIndex(
  blocks: FlattenedTextBlock[],
  sourcePage: number,
  blockId: string | null,
): number {
  const page = Number.isFinite(sourcePage) ? Math.floor(sourcePage) : 1;
  if (blockId !== null) {
    const exact = blocks.findIndex(
      (entry) => entry.page === page && entry.block.id === blockId,
    );
    if (exact >= 0) {
      return exact;
    }
  }
  return blocks.findIndex((entry) => entry.page === page);
}

/**
 * Collects the chapter around the current reflow block: from the nearest
 * preceding heading (the current block when the page has none) up to the next
 * heading, exclusive. The returned `label` is that heading's text.
 */
export function reflowChapterText(
  index: ReflowPackIndex,
  sourcePage: number,
  blockId: string | null,
  maxChars: number,
): { text: string; label: string; truncated: boolean } {
  const page = Number.isFinite(sourcePage) ? Math.floor(sourcePage) : 1;
  const fallbackLabel = `第 ${page} 页`;
  const blocks = flattenTextBlocks(index);
  const current = currentBlockIndex(blocks, page, blockId);
  if (current < 0) {
    const empty = capContextText('', maxChars);
    return { text: empty.text, label: fallbackLabel, truncated: empty.truncated };
  }

  let start = current;
  for (let cursor = current; cursor >= 0; cursor -= 1) {
    if (blocks[cursor]?.block.type === 'heading') {
      start = cursor;
      break;
    }
  }

  let end = blocks.length;
  for (let cursor = start + 1; cursor < blocks.length; cursor += 1) {
    if (blocks[cursor]?.block.type === 'heading') {
      end = cursor;
      break;
    }
  }

  const heading = blocks[start]?.block;
  const headingText = heading?.type === 'heading' ? heading.text?.trim() ?? '' : '';
  const label = headingText.length > 0 ? normalizeContextText(headingText) : fallbackLabel;

  const text = blocks
    .slice(start, end)
    .map((entry) => entry.block.text ?? '')
    .join(PAGE_SEPARATOR);
  const capped = capContextText(text, maxChars);
  return { text: capped.text, label, truncated: capped.truncated };
}
