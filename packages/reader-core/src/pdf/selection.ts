import type { LocatorRect } from '@bookr/shared';
import { normalizeRect, type RectLike } from '../locator';

/**
 * Normalizes the viewport rects of a DOM selection against the full-page box.
 *
 * Every supplied rect is kept: callers decide afterwards whether a zero-area
 * rect is useful. Each rect is clipped to the page and rounded to six decimals
 * by `normalizeRect`, so `x + w <= 1` and `y + h <= 1` always hold.
 */
export function rectsFromClientRects(rects: RectLike[], pageBox: RectLike): LocatorRect[] {
  return rects.map((rect) => normalizeRect(rect, pageBox));
}
