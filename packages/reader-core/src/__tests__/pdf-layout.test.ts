import { describe, expect, it } from 'vitest';
import {
  computeScale,
  focusScrollTop,
  pageFromScroll,
  pagesToRenderInitially,
  spreadPages,
  spreadStart,
} from '../pdf/layout';

const page = { width: 600, height: 800 };
const viewport = { width: 1000, height: 900 };

describe('pdf layout', () => {
  it('computes fit-width, fit-page and numeric zoom', () => {
    expect(computeScale({ page, viewport, zoom: 'fit-width', padding: 24 })).toBeCloseTo(952 / 600, 6);
    expect(computeScale({ page, viewport, zoom: 'fit-page', padding: 24 })).toBeCloseTo(852 / 800, 6);
    expect(computeScale({ page, viewport, zoom: 2, padding: 24 })).toBe(2);
  });

  it('fills the viewport width with fit-width using the default padding', () => {
    // A 360px phone screen must only lose the default inset on both sides,
    // otherwise the page ends up visibly narrower than the reading column.
    const phone = { width: 360, height: 800 };
    const scale = computeScale({ page, viewport: phone, zoom: 'fit-width' });
    expect(scale * page.width).toBeCloseTo(phone.width - 16, 6);
  });

  it('clamps zoom to a usable range', () => {
    expect(computeScale({ page, viewport, zoom: 99, padding: 24 })).toBe(5);
    expect(computeScale({ page, viewport, zoom: 0.1, padding: 24 })).toBe(0.25);
  });

  it('pairs pages for a two-page spread, keeping page 1 alone', () => {
    expect(spreadStart(1)).toBe(1);
    expect(spreadStart(2)).toBe(1);
    expect(spreadStart(4)).toBe(3);
    expect(spreadStart(5)).toBe(5);
  });

  it('finds the page under the reading focus line', () => {
    const tops = [0, 900, 1800];
    expect(pageFromScroll(0, tops, 800)).toBe(1);
    expect(pageFromScroll(950, tops, 800)).toBe(2);
    expect(pageFromScroll(1900, tops, 800)).toBe(3);
  });

  it('builds two-page spreads without skipping page 2', () => {
    expect(spreadPages(1, 10)).toEqual([1]);
    expect(spreadPages(2, 10)).toEqual([1, 2]);
    expect(spreadPages(3, 10)).toEqual([3, 4]);
    expect(spreadPages(4, 10)).toEqual([3, 4]);
    expect(spreadPages(10, 10)).toEqual([9, 10]);
    expect(spreadPages(3, 3)).toEqual([3]);
    expect(spreadPages(1, 1)).toEqual([1]);
  });

  it('paints the whole opening spread before a paged reader opens', () => {
    expect(pagesToRenderInitially('single', 1, 10)).toEqual([1]);
    expect(pagesToRenderInitially('double', 1, 10)).toEqual([1, 2]);
    expect(pagesToRenderInitially('double', 3, 10)).toEqual([3, 4]);
    // The spread clamps at the last page instead of asking for a missing one.
    expect(pagesToRenderInitially('double', 10, 10)).toEqual([9, 10]);
    expect(pagesToRenderInitially('double', 9, 9)).toEqual([9]);
    expect(pagesToRenderInitially('double', 1, 1)).toEqual([1]);
    expect(pagesToRenderInitially('single', 99, 10)).toEqual([10]);
  });

  it('places a locator rect on the focus line, allowing for crop', () => {
    expect(focusScrollTop({
      pageTop: 1000, pageHeight: 800, viewportHeight: 600, rectY: 0.5,
      cropTop: 0.1, cropBottom: 0.1,
    })).toBe(1190);
    expect(focusScrollTop({ pageTop: 1000, pageHeight: 800, viewportHeight: 600 })).toBe(1000);
    expect(focusScrollTop({
      pageTop: 100, pageHeight: 800, viewportHeight: 600, rectY: 0.1,
      cropTop: 0.1, cropBottom: 0.1,
    })).toBe(0);
  });
});
