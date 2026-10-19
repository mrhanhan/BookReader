import type { Locator } from '@bookr/shared';

/**
 * Human-readable position for a note. PDFs report the page, reflow packs the
 * source page, and EPUBs their place in the whole book.
 */
export function describeNotePosition(locator: Locator): string {
  switch (locator.kind) {
    case 'pdf':
      return `第 ${locator.page} 页`;
    case 'reflow':
      return `原书第 ${locator.sourcePage} 页`;
    case 'epub':
      return `全书 ${Math.round(locator.percent * 100)}%`;
  }
}
