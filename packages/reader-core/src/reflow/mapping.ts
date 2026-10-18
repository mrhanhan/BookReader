import type {
  Locator,
  LocatorRect,
  PdfLocator,
  ReflowBlock,
  ReflowLocator,
  ReflowPack,
} from '@bookr/shared';
import { clamp } from '../locator';
import type { PdfReadingMode } from '../types';
import { indexForPack } from './pack';

function safePercent(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? clamp(value, 0, 1) : 0;
}

/**
 * Clamps a page into `1..pageCount`. Without a pack (or with a malformed page
 * count) there is no upper bound to clamp against, so only the lower bound
 * applies and the result can never become NaN.
 */
function safePage(value: number, pageCount: number | null): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) {
    return 1;
  }
  const page = Math.floor(value);
  if (typeof pageCount !== 'number' || !Number.isFinite(pageCount)) {
    return Math.max(1, page);
  }
  return clamp(page, 1, Math.max(1, Math.floor(pageCount)));
}

function cloneRect(rect: LocatorRect): LocatorRect {
  return { x: rect.x, y: rect.y, w: rect.w, h: rect.h };
}

function verticalCenter(rect: LocatorRect): number {
  return rect.y + rect.h / 2;
}

/**
 * Picks the block whose vertical band is closest to the PDF rect's center.
 * A center inside a block counts as distance 0; ties keep pack order.
 */
function matchByRect(blocks: ReflowBlock[], rect: LocatorRect | undefined): ReflowBlock | null {
  if (!rect || typeof rect !== 'object') {
    return null;
  }
  const center = verticalCenter(rect);
  if (!Number.isFinite(center)) {
    return null;
  }

  let best: ReflowBlock | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    const blockRect = block.rect;
    if (!blockRect) {
      continue;
    }
    const inside = center >= blockRect.y && center <= blockRect.y + blockRect.h;
    const distance = inside ? 0 : Math.abs(verticalCenter(blockRect) - center);
    if (distance < bestDistance) {
      best = block;
      bestDistance = distance;
    }
  }
  return best;
}

/**
 * Prefers a block whose `[sourceCharStart, sourceCharEnd)` contains the
 * offset, then the block whose start is nearest to it.
 */
function matchByCharOffset(blocks: ReflowBlock[], charOffset: number | undefined): ReflowBlock | null {
  if (typeof charOffset !== 'number' || !Number.isFinite(charOffset)) {
    return null;
  }

  let best: ReflowBlock | null = null;
  let bestDistance = Number.POSITIVE_INFINITY;
  for (const block of blocks) {
    const start = block.sourceCharStart;
    if (typeof start !== 'number' || !Number.isFinite(start)) {
      continue;
    }
    const end = typeof block.sourceCharEnd === 'number' && Number.isFinite(block.sourceCharEnd)
      ? block.sourceCharEnd
      : start;
    const distance = charOffset >= start && charOffset < end ? 0 : Math.abs(start - charOffset);
    if (distance < bestDistance) {
      best = block;
      bestDistance = distance;
    }
  }
  return best;
}

function cloneReflowLocator(locator: ReflowLocator, pageCount: number | null): ReflowLocator {
  const result: ReflowLocator = {
    kind: 'reflow',
    sourcePage: safePage(locator.sourcePage, pageCount),
    percent: safePercent(locator.percent),
  };
  if (locator.blockId !== undefined) {
    result.blockId = locator.blockId;
  }
  if (locator.charRange !== undefined) {
    result.charRange = [locator.charRange[0], locator.charRange[1]];
  }
  if (locator.ranges !== undefined) {
    result.ranges = locator.ranges.map((range) => ({
      blockId: range.blockId,
      charRange: [range.charRange[0], range.charRange[1]],
    }));
  }
  return result;
}

function clonePdfLocator(locator: PdfLocator, pageCount: number | null): PdfLocator {
  const result: PdfLocator = {
    kind: 'pdf',
    page: safePage(locator.page, pageCount),
    percent: safePercent(locator.percent),
  };
  if (locator.rect) {
    result.rect = cloneRect(locator.rect);
  }
  if (locator.rects) {
    result.rects = locator.rects.map(cloneRect);
  }
  if (locator.charOffset !== undefined) {
    result.charOffset = locator.charOffset;
  }
  return result;
}

/**
 * Maps any locator into the reflow view.
 *
 * PDF locators resolve to a source page and block: by the rect's vertical
 * position first, then by char offset, then by the page's first text block.
 * EPUB locators cannot map and yield null. Existing reflow locators are
 * preserved (including cross-block ranges) with the page clamped to the pack.
 */
export function reflowLocatorFor(locator: Locator, pack: ReflowPack): ReflowLocator | null {
  try {
    if (!locator || typeof locator !== 'object') {
      return null;
    }
    if (locator.kind !== 'pdf' && locator.kind !== 'reflow') {
      return null;
    }
    const index = indexForPack(pack);
    if (locator.kind === 'reflow') {
      return cloneReflowLocator(locator, index.pageCount);
    }

    const sourcePage = safePage(locator.page, index.pageCount);
    const blocks = index.page(sourcePage)?.blocks ?? [];
    const block =
      matchByRect(blocks, locator.rect) ??
      matchByCharOffset(blocks, locator.charOffset) ??
      index.firstTextBlock(sourcePage);

    const result: ReflowLocator = {
      kind: 'reflow',
      sourcePage,
      percent: safePercent(locator.percent),
    };
    if (block) {
      result.blockId = block.id;
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Maps any locator into the original PDF view.
 *
 * Reflow locators keep their source page; when the pack is available and the
 * block still exists, the block's rect and caret offset are restored. Without
 * a pack (or for a stale block id) only the page survives. EPUB locators
 * cannot map and yield null.
 */
export function pdfLocatorFor(locator: Locator, pack?: ReflowPack | null): PdfLocator | null {
  try {
    if (!locator || typeof locator !== 'object') {
      return null;
    }
    if (locator.kind !== 'pdf' && locator.kind !== 'reflow') {
      return null;
    }
    const index = pack ? indexForPack(pack) : null;
    const pageCount = index?.pageCount ?? null;

    if (locator.kind === 'pdf') {
      return clonePdfLocator(locator, pageCount);
    }

    const page = safePage(locator.sourcePage, pageCount);
    const result: PdfLocator = {
      kind: 'pdf',
      page,
      percent: safePercent(locator.percent),
    };

    const block = locator.blockId
      ? index?.page(page)?.blocks.find((candidate) => candidate.id === locator.blockId) ?? null
      : null;
    if (block) {
      result.rect = cloneRect(block.rect);
      if (block.sourceCharStart !== undefined && locator.charRange) {
        result.charOffset = block.sourceCharStart + locator.charRange[0];
      }
    }
    return result;
  } catch {
    return null;
  }
}

/**
 * Normalizes a locator for the requested PDF reading mode. Without a pack the
 * PDF locator is the best available position, so a normalized copy is returned
 * for reflow mode; reflow locators downgrade to their source page.
 */
export function locatorForMode(
  locator: Locator,
  mode: PdfReadingMode,
  pack?: ReflowPack | null,
): Locator | null {
  try {
    if (!locator || typeof locator !== 'object') {
      return null;
    }
    if (locator.kind !== 'pdf' && locator.kind !== 'reflow') {
      return null;
    }
    if (mode === 'reflow') {
      if (pack) {
        return reflowLocatorFor(locator, pack);
      }
      return locator.kind === 'reflow'
        ? cloneReflowLocator(locator, null)
        : clonePdfLocator(locator, null);
    }
    return pdfLocatorFor(locator, pack);
  } catch {
    return null;
  }
}
