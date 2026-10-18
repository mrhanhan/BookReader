import type { AnnotationColor } from '@bookr/shared';

import { HIGHLIGHT_HEX } from '../settings';
import type { ReaderHighlight } from '../types';

/** One highlight range ready to be painted inside a rendered text block. */
export interface ReflowMark {
  id: string;
  blockId: string;
  /**
   * Source page the highlight was anchored on. Block ids are only unique per
   * page, so rendering must not apply a page 1 mark to a same-id block on
   * another page. Cross-page `ranges` are best-effort: every range inherits
   * the locator's `sourcePage` because the schema stores no page per range.
   */
  sourcePage: number;
  charRange: [number, number];
  color: AnnotationColor;
  hasNote: boolean;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Groups reflow highlights into per-block marks.
 *
 * A highlight that stores cross-block `ranges` contributes one mark per range;
 * a single-block highlight falls back to its `blockId` + `charRange`. Other
 * locator kinds and locators without a usable range are ignored.
 */
export function marksForHighlights(highlights: ReaderHighlight[]): Map<string, ReflowMark[]> {
  const result = new Map<string, ReflowMark[]>();
  if (!Array.isArray(highlights)) {
    return result;
  }

  for (const highlight of highlights) {
    if (!highlight || typeof highlight !== 'object') {
      continue;
    }
    if (typeof highlight.id !== 'string' || highlight.id.length === 0) {
      continue;
    }
    const locator = highlight.locator;
    if (!locator || locator.kind !== 'reflow') {
      continue;
    }
    const rawPage = locator.sourcePage;
    const sourcePage = typeof rawPage === 'number' && Number.isFinite(rawPage) && rawPage >= 1
      ? Math.floor(rawPage)
      : 1;

    const locatorRanges = Array.isArray(locator.ranges) ? locator.ranges : [];
    const ranges = locatorRanges.length > 0
      ? locatorRanges
      : locator.blockId && locator.charRange
        ? [{ blockId: locator.blockId, charRange: locator.charRange }]
        : [];

    for (const range of ranges) {
      // Persisted annotations may predate a schema change; skip garbage
      // entries instead of letting destructuring throw.
      if (!range || typeof range !== 'object') {
        continue;
      }
      if (!Array.isArray(range.charRange) || range.charRange.length < 2) {
        continue;
      }
      if (typeof range.blockId !== 'string' || range.blockId.length === 0) {
        continue;
      }
      const [start, end] = range.charRange;
      if (typeof start !== 'number' || typeof end !== 'number') {
        continue;
      }
      if (!Number.isFinite(start) || !Number.isFinite(end)) {
        continue;
      }
      const mark: ReflowMark = {
        id: highlight.id,
        blockId: range.blockId,
        sourcePage,
        charRange: [start, end],
        color: highlight.color,
        hasNote: highlight.hasNote === true,
      };
      const group = result.get(range.blockId);
      if (group) {
        group.push(mark);
      } else {
        result.set(range.blockId, [mark]);
      }
    }
  }

  return result;
}

interface NormalizedMark {
  mark: ReflowMark;
  start: number;
  end: number;
}

/**
 * Rebuilds a text block as plain text nodes plus `<mark>` segments.
 *
 * Marks are clamped to the text; inverted or empty ranges are dropped, and a
 * mark recorded for another block id is ignored (block ids repeat across
 * pages, so the element is the authority). Every segment boundary comes from a
 * mark start/end, so each segment is either fully covered or uncovered. Where
 * marks overlap the last applicable mark wins, matching the order highlights
 * were supplied in. Text is always inserted through `createTextNode`, never
 * parsed as HTML.
 */
export function renderBlockText(block: HTMLElement, text: string, marks: ReflowMark[]): void {
  const document = block.ownerDocument;
  const value = typeof text === 'string' ? text : '';
  const length = value.length;
  const blockId = block.dataset.blockId ?? '';

  const normalized: NormalizedMark[] = [];
  for (const mark of marks) {
    if (!mark || !mark.charRange) {
      continue;
    }
    if (blockId.length === 0 || mark.blockId !== blockId) {
      continue;
    }
    const start = clamp(Math.floor(mark.charRange[0]), 0, length);
    const end = clamp(Math.floor(mark.charRange[1]), 0, length);
    if (end > start) {
      normalized.push({ mark, start, end });
    }
  }

  const boundaries = new Set<number>([0, length]);
  for (const item of normalized) {
    boundaries.add(item.start);
    boundaries.add(item.end);
  }
  const points = [...boundaries].sort((left, right) => left - right);

  const nodes: Node[] = [];
  for (let index = 0; index < points.length - 1; index += 1) {
    const start = points[index] as number;
    const end = points[index + 1] as number;
    if (end <= start) {
      continue;
    }

    let covering: ReflowMark | null = null;
    for (const item of normalized) {
      if (item.start <= start && end <= item.end) {
        // Later marks are drawn on top, so they keep the segment.
        covering = item.mark;
      }
    }

    const segment = value.slice(start, end);
    if (!covering) {
      nodes.push(document.createTextNode(segment));
      continue;
    }

    const mark = document.createElement('mark');
    mark.className = 'bookr-reflow-mark';
    if (covering.hasNote) {
      mark.classList.add('has-note');
    }
    mark.dataset.highlightId = covering.id;
    mark.style.backgroundColor = HIGHLIGHT_HEX[covering.color];
    mark.append(document.createTextNode(segment));
    nodes.push(mark);
  }

  block.replaceChildren(...nodes);
}
