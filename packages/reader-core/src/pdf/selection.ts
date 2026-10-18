import type { LocatorRect } from '@bookr/shared';
import { clamp, type RectLike } from '../locator';

/**
 * Fraction of a page reserved for a rect whose start lies at or beyond the
 * page edge. A selection touch at the right or bottom edge would otherwise
 * normalize to zero size and disappear; a tiny visible sliver keeps it usable.
 */
const EDGE_SLIVER = 0.05;

const COORDINATE_UNITS = 1_000_000;

interface NormalizedAxis {
  start: number;
  size: number;
}

function roundUnits(value: number): number {
  const units = Math.round(value * COORDINATE_UNITS);
  return (units === 0 ? 0 : clamp(units, 0, COORDINATE_UNITS)) / COORDINATE_UNITS;
}

function normalizeAxis(start: number, size: number, origin: number, extent: number): NormalizedAxis {
  if (!(extent > 0) || !Number.isFinite(extent)) {
    return { start: 0, size: 0 };
  }

  const rawStart = (start - origin) / extent;
  const rawEnd = (start + size - origin) / extent;
  const begin = Number.isFinite(rawStart) ? clamp(rawStart, 0, 1 - EDGE_SLIVER) : 0;
  const end = Number.isFinite(rawEnd) ? clamp(rawEnd, begin, 1) : begin;

  return { start: roundUnits(begin), size: roundUnits(end - begin) };
}

/**
 * Normalizes the viewport rects of a DOM selection against the full-page box.
 *
 * Every supplied rect is kept: callers decide afterwards whether a zero-area
 * rect is useful. Coordinates are clipped to the page and rounded to six
 * decimals, so `x + w <= 1` and `y + h <= 1` always hold.
 */
export function rectsFromClientRects(rects: RectLike[], pageBox: RectLike): LocatorRect[] {
  return rects.map((rect) => {
    const x = normalizeAxis(rect.left, rect.width, pageBox.left, pageBox.width);
    const y = normalizeAxis(rect.top, rect.height, pageBox.top, pageBox.height);
    return { x: x.start, y: y.start, w: x.size, h: y.size };
  });
}
