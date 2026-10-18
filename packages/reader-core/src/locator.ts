import type { EpubLocator, Locator, LocatorRect, PdfLocator } from '@bookr/shared';

/** A viewport-relative rectangle, mirroring the parts of `DOMRect` we need. */
export interface RectLike {
  left: number;
  top: number;
  width: number;
  height: number;
}

const COORDINATE_UNITS = 1_000_000;

/** Restricts `value` to the inclusive `[min, max]` range. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function finiteOr(value: number, fallback: number): number {
  return Number.isFinite(value) ? value : fallback;
}

function safePageCount(pageCount: number): number {
  return Number.isFinite(pageCount) && pageCount >= 1 ? Math.floor(pageCount) : 1;
}

/**
 * Converts a 1-based page plus a fraction of that page into a 0–1 book percentage.
 * The fraction is clamped so callers can pass raw selection offsets safely.
 */
export function percentForPage(page: number, pageCount: number, intraPageFraction = 0): number {
  const count = safePageCount(pageCount);
  const current = clamp(finiteOr(page, 1), 1, count);
  const fraction = clamp(finiteOr(intraPageFraction, 0), 0, 1);
  return (current - 1 + fraction) / count;
}

/** Converts a 0–1 book percentage into a 1-based page inside `[1, pageCount]`. */
export function pageForPercent(percent: number, pageCount: number): number {
  const count = safePageCount(pageCount);
  const position = clamp(finiteOr(percent, 0), 0, 1);
  // The epsilon keeps exact boundaries such as 0.3 * 10 from falling a page short.
  return clamp(Math.floor(position * count + 1e-9) + 1, 1, count);
}

interface NormalizedAxis {
  start: number;
  size: number;
}

/**
 * Clips one axis of a client rect to the page box, then rounds to 6 decimals.
 * Values are rounded at `COORDINATE_UNITS` precision; the final overflow guard
 * keeps `start + size <= 1` even when floating-point addition rounds upward.
 */
function normalizeAxis(start: number, size: number, origin: number, extent: number): NormalizedAxis {
  const clippedStart = finiteOr(clamp(start - origin, 0, extent), 0);
  const clippedEnd = finiteOr(clamp(start - origin + size, 0, extent), 0);

  const startUnits = clamp(
    Math.round((clippedStart / extent) * COORDINATE_UNITS),
    0,
    COORDINATE_UNITS,
  );
  let sizeUnits = clamp(
    Math.round(((clippedEnd - clippedStart) / extent) * COORDINATE_UNITS),
    0,
    COORDINATE_UNITS - startUnits,
  );

  const startOut = startUnits / COORDINATE_UNITS;
  let sizeOut = sizeUnits / COORDINATE_UNITS;
  while (sizeUnits > 0 && startOut + sizeOut > 1) {
    sizeUnits -= 1;
    sizeOut = sizeUnits / COORDINATE_UNITS;
  }

  // Normalize -0 so structured equality with defaults behaves predictably.
  return { start: startOut === 0 ? 0 : startOut, size: sizeOut === 0 ? 0 : sizeOut };
}

/**
 * Converts a viewport client rect into a rect normalized against the page box.
 * Both edges are clipped to the page and every output value is rounded to six
 * decimals, so `x + w <= 1` and `y + h <= 1` always hold.
 */
export function normalizeRect(rect: RectLike, bounds: RectLike): LocatorRect {
  const width = finiteOr(bounds.width, 0);
  const height = finiteOr(bounds.height, 0);
  if (!(width > 0) || !(height > 0)) {
    return { x: 0, y: 0, w: 0, h: 0 };
  }

  const x = normalizeAxis(
    finiteOr(rect.left, 0),
    finiteOr(rect.width, 0),
    finiteOr(bounds.left, 0),
    width,
  );
  const y = normalizeAxis(
    finiteOr(rect.top, 0),
    finiteOr(rect.height, 0),
    finiteOr(bounds.top, 0),
    height,
  );

  return { x: x.start, y: y.start, w: x.size, h: y.size };
}

/** Narrows a locator to the PDF variant. */
export function isPdfLocator(locator: Locator): locator is PdfLocator {
  return locator.kind === 'pdf';
}

/** Narrows a locator to the EPUB variant. */
export function isEpubLocator(locator: Locator): locator is EpubLocator {
  return locator.kind === 'epub';
}
