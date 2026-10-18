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

/** The spine surface `spineCfiFor` needs; satisfied by an epub.js `Book`. */
export interface EpubSpineLike {
  get?: (target: string) => unknown;
  spineItems?: unknown;
}

export interface EpubBookLike {
  spine?: EpubSpineLike | null;
  canonical?: (href: string) => unknown;
}

function stripFragment(value: string): string {
  const hash = value.indexOf('#');
  return hash === -1 ? value : value.slice(0, hash);
}

function safeDecode(value: string): string | null {
  try {
    return decodeURI(value);
  } catch {
    return null;
  }
}

function pathSegments(value: string): string[] {
  const withoutQuery = stripFragment(value).split('?')[0] ?? '';
  return withoutQuery
    .split('/')
    .filter((segment) => segment.length > 0 && segment !== '.' && segment !== '..');
}

function isPathSuffix(target: string, wanted: readonly string[]): boolean {
  if (wanted.length === 0) {
    return false;
  }
  const segments = pathSegments(target);
  if (segments.length === 0) {
    return false;
  }
  // Absolute URLs are longer than spine-relative paths, and the nav document
  // may add directory segments, so accept either side as the suffix.
  const shorter = wanted.length <= segments.length ? wanted : segments;
  const longer = wanted.length <= segments.length ? segments : wanted;
  const offset = longer.length - shorter.length;
  return shorter.every((segment, index) => longer[offset + index] === segment);
}

/**
 * `Section.cfiBase` is the chapter component (`/6/4[ch1]`), not a complete CFI.
 * epub.js requires a local path after the `!` indirection to parse a CFI, so
 * the chapter-start CFI points at the chapter's body element (`!/4`). A TOC href
 * fragment is not representable this way; callers keep the href on the locator.
 */
function sectionCfi(section: unknown): string | null {
  const base = (section as { cfiBase?: unknown } | null)?.cfiBase;
  if (typeof base !== 'string' || base.length === 0) {
    return null;
  }
  if (base.startsWith('epubcfi(')) {
    return base;
  }
  return `epubcfi(${base}${base.includes('!') ? '' : '!/4'})`;
}

/**
 * Resolves a navigation href to a real CFI.
 *
 * `book.canonical()` returns a resolved URL, not a CFI, so it cannot be used as
 * a reading position directly. The spine lookup is tried with the raw href, its
 * fragment-less form, decoded forms, and the resolved URL; navigation documents
 * that live in another directory are matched by path suffix against the spine
 * items. Unresolvable hrefs return `null`.
 */
export function spineCfiFor(book: EpubBookLike, href: string): string | null {
  if (typeof href !== 'string' || href.length === 0) {
    return null;
  }
  const spine = book.spine;
  if (!spine) {
    return null;
  }

  const candidates = new Set<string>();
  const addCandidate = (value: unknown): void => {
    if (typeof value === 'string' && value.length > 0) {
      candidates.add(value);
    }
  };

  addCandidate(href);
  addCandidate(stripFragment(href));
  addCandidate(safeDecode(href));
  addCandidate(safeDecode(stripFragment(href)));
  try {
    const canonical = book.canonical?.(href);
    addCandidate(canonical);
    if (typeof canonical === 'string') {
      addCandidate(stripFragment(canonical));
      addCandidate(safeDecode(canonical));
    }
  } catch {
    // A broken canonical resolver must not stop the TOC from resolving.
  }

  const get = spine.get;
  if (typeof get === 'function') {
    for (const candidate of candidates) {
      try {
        const cfi = sectionCfi(get.call(spine, candidate));
        if (cfi) {
          return cfi;
        }
      } catch {
        // Try the next candidate.
      }
    }
  }

  // Navigation documents may live in a different directory than the OPF, so
  // compare path tails as a last resort.
  const items = Array.isArray(spine.spineItems) ? spine.spineItems : [];
  for (const candidate of candidates) {
    const wanted = pathSegments(candidate);
    if (wanted.length === 0) {
      continue;
    }
    for (const item of items) {
      const cfi = sectionCfi(item);
      if (!cfi) {
        continue;
      }
      const record = item as { href?: unknown; url?: unknown; canonical?: unknown };
      const targets = [record.href, record.url, record.canonical]
        .flatMap((target) => {
          if (typeof target !== 'string') {
            return [];
          }
          const decoded = safeDecode(target);
          return decoded && decoded !== target ? [target, decoded] : [target];
        });
      if (targets.some((target) => isPathSuffix(target, wanted))) {
        return cfi;
      }
    }
  }

  return null;
}

/** A `CanonicalHref` backed by an epub.js book; unresolved hrefs return `''`. */
export function bookHrefResolver(book: EpubBookLike): CanonicalHref {
  return (href) => spineCfiFor(book, href) ?? '';
}

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
