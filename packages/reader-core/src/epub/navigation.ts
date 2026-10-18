import type { EpubLocator } from '@bookr/shared';

import { clamp } from '../locator';
import type { TocItem } from '../types';

/**
 * The parts of an epub.js navigation item this package relies on. `id` is
 * optional because TOC entries are identified by their position, not the
 * document-supplied id.
 */
export interface EpubNavigationItem {
  id?: string;
  label: string;
  href: string;
  subitems?: EpubNavigationItem[];
}

/** Resolves a manifest-relative href to the CFI that points at its section. */
export type CanonicalHref = (href: string) => string;

/**
 * Builds an EPUB locator. The percentage is clamped to 0–1 and `href` is
 * omitted when it is missing or empty, because the shared schema requires a
 * non-empty href when present.
 */
export function epubLocator(
  cfi: string,
  href: string | undefined,
  percent: number,
): EpubLocator {
  const locator: EpubLocator = {
    kind: 'epub',
    cfi,
    percent: clamp(Number.isFinite(percent) ? percent : 0, 0, 1),
  };
  if (typeof href === 'string' && href.length > 0) {
    locator.href = href;
  }
  return locator;
}

/**
 * Flattens the nested EPUB navigation into a depth-first list. Entries whose
 * canonical lookup throws (hrefs absent from the spine are common in the wild)
 * are skipped without failing the whole TOC.
 */
export function flattenNavigation(
  items: readonly EpubNavigationItem[],
  canonical: CanonicalHref,
  depth = 0,
): TocItem[] {
  return flattenLevel(items, canonical, depth, []);
}

function flattenLevel(
  items: readonly EpubNavigationItem[],
  canonical: CanonicalHref,
  depth: number,
  parentPath: readonly string[],
): TocItem[] {
  const toc: TocItem[] = [];

  items.forEach((item, index) => {
    const path = [...parentPath, String(index)];
    const href = item.href;
    if (typeof href !== 'string' || href.length === 0) {
      return;
    }

    let cfi: string;
    try {
      cfi = canonical(href);
    } catch {
      return;
    }
    if (typeof cfi !== 'string' || cfi.length === 0) {
      return;
    }

    toc.push({
      id: `toc-${path.join('-')}`,
      label: item.label,
      depth,
      locator: epubLocator(cfi, href, 0),
      children: [],
    });

    if (item.subitems && item.subitems.length > 0) {
      toc.push(...flattenLevel(item.subitems, canonical, depth + 1, path));
    }
  });

  return toc;
}
