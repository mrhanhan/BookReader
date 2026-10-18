import { reflowPackSchema } from '@bookr/shared';
import type { ReflowBlock, ReflowPage, ReflowPack } from '@bookr/shared';

/** Block type the reflow engine renders as selectable prose. */
function isTextBlock(block: ReflowBlock): boolean {
  return block.type === 'heading' || block.type === 'paragraph';
}

/** A block together with the pack page that owns it. */
export interface IndexedReflowBlock {
  block: ReflowBlock;
  page: ReflowPage;
}

/**
 * O(1) lookups over a validated reflow pack.
 *
 * Block ids are unique per page, not per pack, so `block(id)` returns the
 * first page that uses the id; locator mapping must stay page-scoped and use
 * `page(sourcePage)` instead.
 */
export class ReflowPackIndex {
  readonly pageCount: number;
  private readonly byPage = new Map<number, ReflowPage>();
  private readonly pagesByNumber = new Map<number, ReflowPage>();
  private readonly blocksById = new Map<string, IndexedReflowBlock>();

  constructor(readonly pack: ReflowPack) {
    this.pageCount = pack.source.pageCount;

    for (const [index, page] of pack.pages.entries()) {
      this.byPage.set(index + 1, page);
      this.pagesByNumber.set(page.page, page);
      for (const block of page.blocks) {
        // Keep the first occurrence so repeated ids stay deterministic.
        if (!this.blocksById.has(block.id)) {
          this.blocksById.set(block.id, { block, page });
        }
      }
    }
  }

  /** Page by its 1-based pack number, or null when the pack has no such page. */
  page(page: number): ReflowPage | null {
    if (!Number.isFinite(page)) {
      return null;
    }
    const number = Math.floor(page);
    return this.pagesByNumber.get(number) ?? this.byPage.get(number) ?? null;
  }

  block(id: string): IndexedReflowBlock | null {
    return this.blocksById.get(id) ?? null;
  }

  /** Selectable prose blocks on a page, in pack order. */
  textBlocksOnPage(page: number): ReflowBlock[] {
    return this.page(page)?.blocks.filter(isTextBlock) ?? [];
  }

  firstTextBlock(page: number): ReflowBlock | null {
    return this.textBlocksOnPage(page)[0] ?? null;
  }

  toc(): ReflowPack['toc'] {
    return this.pack.toc;
  }
}

const indexCache = new WeakMap<ReflowPack, ReflowPackIndex>();

/** Returns a cached index for a parsed pack; mapping calls share one instance. */
export function indexForPack(pack: ReflowPack): ReflowPackIndex {
  const cached = indexCache.get(pack);
  if (cached) {
    return cached;
  }
  const index = new ReflowPackIndex(pack);
  indexCache.set(pack, index);
  return index;
}

/**
 * Validates an untrusted pack payload and returns it typed. Every failure is
 * reported as the stable `Invalid reflow pack` message so callers can surface
 * one user-facing error regardless of the underlying schema issue.
 */
export function indexReflowPack(value: unknown): ReflowPack {
  let parsed;
  try {
    parsed = reflowPackSchema.safeParse(value);
  } catch {
    throw new Error('Invalid reflow pack');
  }
  if (!parsed.success) {
    throw new Error('Invalid reflow pack');
  }
  return parsed.data;
}
