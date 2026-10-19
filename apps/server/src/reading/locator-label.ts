import type { Locator } from '@bookr/shared';

/** Human-readable Chinese label for a reading location. */
export function describeLocator(locator: Locator | undefined): string {
  if (!locator) {
    return '未提供位置';
  }

  // EPUB has no page number, so whole-book progress is the only location label.
  if (locator.kind === 'epub') {
    return `全书 ${Math.round(locator.percent * 100)}%`;
  }

  const label = locator.kind === 'pdf' ? `第 ${locator.page} 页` : `源页 ${locator.sourcePage}`;
  if (typeof locator.percent === 'number') {
    return `${label}（全书 ${Math.round(locator.percent * 100)}%）`;
  }
  return label;
}
