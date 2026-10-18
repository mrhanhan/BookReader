import { clamp } from '../locator';

export interface PageSize {
  width: number;
  height: number;
}

export interface ViewportSize {
  width: number;
  height: number;
}

export type PdfZoom = number | 'fit-width' | 'fit-page';

export interface ComputeScaleOptions {
  page: PageSize;
  viewport: ViewportSize;
  zoom: PdfZoom;
  padding?: number;
}

/** Breathing room around a page in both fit modes, in CSS pixels. */
export const DEFAULT_PAGE_PADDING = 24;

/** Smallest and largest scale a reader can pick, matching `mergeReaderSettings`. */
export const MIN_SCALE = 0.25;
export const MAX_SCALE = 5;

function positiveOr(value: number, fallback: number): number {
  return Number.isFinite(value) && value > 0 ? value : fallback;
}

function available(value: number, padding: number): number {
  return Math.max(0, (Number.isFinite(value) ? value : 0) - padding * 2);
}

/**
 * Turns a zoom setting into a concrete render scale for one page.
 *
 * `fit-width` uses the full container width, `fit-page` fits both axes, and a
 * numeric zoom is taken as-is. Every result is clamped to the usable range so a
 * hostile or stale setting can never produce a zero-sized page.
 */
export function computeScale({ page, viewport, zoom, padding = DEFAULT_PAGE_PADDING }: ComputeScaleOptions): number {
  const pageWidth = positiveOr(page.width, 1);
  const pageHeight = positiveOr(page.height, 1);
  const inset = Number.isFinite(padding) && padding >= 0 ? padding : DEFAULT_PAGE_PADDING;
  const width = available(viewport.width, inset);
  const height = available(viewport.height, inset);

  let scale: number;
  if (zoom === 'fit-width') {
    scale = width / pageWidth;
  } else if (zoom === 'fit-page') {
    scale = Math.min(width / pageWidth, height / pageHeight);
  } else if (Number.isFinite(zoom)) {
    scale = zoom;
  } else {
    scale = 1;
  }

  return clamp(scale, MIN_SCALE, MAX_SCALE);
}

/**
 * First page of the two-page spread that contains `page`. Page 1 is alone, so
 * the first spread starts at 1; every later spread pairs an odd page with the
 * page after it.
 */
export function spreadStart(page: number): number {
  const current = Number.isFinite(page) ? Math.max(1, Math.floor(page)) : 1;
  return current % 2 === 0 ? current - 1 : current;
}

/**
 * Index of the page under the reading focus line, which sits a third of a
 * viewport below the top edge. Returns a 1-based page, or 1 for empty input.
 */
export function pageFromScroll(scrollTop: number, pageTops: number[], viewportHeight: number): number {
  if (pageTops.length === 0) {
    return 1;
  }

  const focus = (Number.isFinite(scrollTop) ? scrollTop : 0)
    + (Number.isFinite(viewportHeight) ? viewportHeight : 0) / 3;

  let page = 1;
  for (let index = 0; index < pageTops.length; index += 1) {
    const top = pageTops[index];
    if (typeof top === 'number' && top <= focus) {
      page = index + 1;
    } else {
      break;
    }
  }
  return page;
}
