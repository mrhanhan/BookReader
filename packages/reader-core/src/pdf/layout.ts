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

/**
 * Position of the reading focus line inside the viewport. Shared by scroll
 * position reporting and locator restoration so a round trip is stable.
 */
export const FOCUS_RATIO = 0.35;

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
 * Index of the page under the reading focus line. Returns a 1-based page, or 1
 * for empty input.
 */
export function pageFromScroll(scrollTop: number, pageTops: number[], viewportHeight: number): number {
  if (pageTops.length === 0) {
    return 1;
  }

  const focus = (Number.isFinite(scrollTop) ? scrollTop : 0)
    + (Number.isFinite(viewportHeight) ? viewportHeight : 0) * FOCUS_RATIO;

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

/**
 * Pages shown together in two-page mode: page 1 stands alone, every later
 * spread pairs an odd page with the next one, and the final spread clamps to
 * the page count. Page 2 therefore belongs to the first spread instead of
 * being skipped.
 */
export function spreadPages(page: number, pageCount: number): number[] {
  const count = Number.isFinite(pageCount) ? Math.max(1, Math.floor(pageCount)) : 1;
  const current = clamp(Number.isFinite(page) ? page : 1, 1, count);
  if (current <= 1) {
    return [1];
  }

  const start = spreadStart(current);
  const pages = [start];
  if (start + 1 <= count) {
    pages.push(start + 1);
  }
  return pages;
}

export interface FocusScrollOptions {
  /** Content offset of the page slot's top edge. */
  pageTop: number;
  /** Layout height of the page slot (cropped size). */
  pageHeight: number;
  viewportHeight: number;
  /** Full-page fraction of the target, when the locator carries a rect. */
  rectY?: number;
  cropTop?: number;
  cropBottom?: number;
}

/**
 * Scroll offset that puts a locator's rect on the reading focus line.
 *
 * The rect is expressed in full-page coordinates while the slot shows the
 * cropped region, so it is first mapped back into the visible page and then
 * lifted by the focus line. Locators without a rect stay top-aligned so TOC and
 * page-number jumps land at the top of the page.
 */
export function focusScrollTop({
  pageTop,
  pageHeight,
  viewportHeight,
  rectY,
  cropTop = 0,
  cropBottom = 0,
}: FocusScrollOptions): number {
  const top = Number.isFinite(pageTop) ? pageTop : 0;
  if (rectY === undefined || !Number.isFinite(rectY)) {
    return Math.max(0, top);
  }

  const visibleHeight = Math.max(1e-6, 1 - cropTop - cropBottom);
  const visibleFraction = clamp((rectY - cropTop) / visibleHeight, 0, 1);
  const height = Number.isFinite(pageHeight) ? pageHeight : 0;
  const viewport = Number.isFinite(viewportHeight) ? viewportHeight : 0;
  return Math.max(0, top + visibleFraction * height - viewport * FOCUS_RATIO);
}
