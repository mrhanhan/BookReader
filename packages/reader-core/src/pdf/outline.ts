import type { PdfLocator } from '@bookr/shared';
import type { TocItem } from '../types';
import { clamp, percentForPage } from '../locator';

/**
 * A table-of-contents entry produced for a PDF: its locator is always a PDF
 * locator, which lets callers read `page` without narrowing the shared union.
 */
export interface PdfTocItem extends TocItem {
  locator: PdfLocator;
}

/** One node of the tree returned by `PDFDocumentProxy.getOutline()`. */
export interface PdfOutlineNode {
  /** Human-readable chapter title. */
  title?: unknown;
  /** Named destination string, explicit destination array, or `null`. */
  dest?: unknown;
  /** Nested chapters. */
  items?: readonly PdfOutlineNode[];
}

/**
 * Resolves an outline destination to a 1-based page number, or `null` when the
 * destination cannot be followed.
 */
export type ResolvePdfPage = (dest: unknown) => number | null | Promise<number | null>;

function safePageCount(pageCount: number): number {
  return Number.isFinite(pageCount) && pageCount >= 1 ? Math.floor(pageCount) : 1;
}

function fallbackToc(pageCount: number): PdfTocItem[] {
  return Array.from({ length: pageCount }, (_, index) => {
    const page = index + 1;
    return {
      id: `toc-page-${page}`,
      label: `第 ${page} 页`,
      depth: 0,
      locator: { kind: 'pdf', page, percent: percentForPage(page, pageCount) },
      children: [],
    };
  });
}

async function resolvePageOf(node: PdfOutlineNode, resolvePage: ResolvePdfPage): Promise<number | null> {
  if (node.dest === undefined || node.dest === null) {
    return null;
  }
  try {
    const page = await resolvePage(node.dest);
    return typeof page === 'number' && Number.isFinite(page) ? Math.floor(page) : null;
  } catch {
    // A broken destination must not hide the rest of the outline.
    return null;
  }
}

/**
 * Flattens a pdf.js outline depth-first into the reader's `TocItem` shape.
 *
 * Items keep `children: []` for forward compatibility and expose nesting
 * through `depth`. Unresolvable destinations are skipped (their resolvable
 * children are still visited). An empty or entirely unresolvable outline falls
 * back to one entry per page so the table of contents is never empty.
 */
export async function buildPdfToc(
  outline: readonly PdfOutlineNode[] | null | undefined,
  pageCount: number,
  resolvePage: ResolvePdfPage,
): Promise<PdfTocItem[]> {
  const count = safePageCount(pageCount);
  const items: PdfTocItem[] = [];

  async function walk(nodes: readonly PdfOutlineNode[], depth: number, path: number[]): Promise<void> {
    for (let index = 0; index < nodes.length; index += 1) {
      const node = nodes[index];
      if (!node || typeof node !== 'object') {
        continue;
      }

      const itemPath = [...path, index];
      const label = typeof node.title === 'string' ? node.title.trim() : '';
      const page = label ? await resolvePageOf(node, resolvePage) : null;

      if (label && page !== null) {
        const clamped = clamp(page, 1, count);
        items.push({
          id: `toc-${itemPath.join('-')}`,
          label,
          depth,
          locator: { kind: 'pdf', page: clamped, percent: percentForPage(clamped, count) },
          children: [],
        });
      }

      if (Array.isArray(node.items) && node.items.length > 0) {
        await walk(node.items, depth + 1, itemPath);
      }
    }
  }

  await walk(Array.isArray(outline) ? outline : [], 0, []);

  return items.length > 0 ? items : fallbackToc(count);
}
