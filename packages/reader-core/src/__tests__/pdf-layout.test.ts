import { describe, expect, it } from 'vitest';
import { computeScale, pageFromScroll, spreadStart } from '../pdf/layout';

const page = { width: 600, height: 800 };
const viewport = { width: 1000, height: 900 };

describe('pdf layout', () => {
  it('computes fit-width, fit-page and numeric zoom', () => {
    expect(computeScale({ page, viewport, zoom: 'fit-width', padding: 24 })).toBeCloseTo(952 / 600, 6);
    expect(computeScale({ page, viewport, zoom: 'fit-page', padding: 24 })).toBeCloseTo(852 / 800, 6);
    expect(computeScale({ page, viewport, zoom: 2, padding: 24 })).toBe(2);
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
});
