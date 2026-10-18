import { describe, expect, it } from 'vitest';
import { charOffsetForRange, pageTextOf } from '../pdf/text-layer';
import { rectsFromClientRects } from '../pdf/selection';

it('normalizes multiple client rects against the page box', () => {
  const pageBox = { left: 100, top: 50, width: 200, height: 400 };
  expect(rectsFromClientRects([
    { left: 120, top: 70, width: 20, height: 40 },
    { left: 300, top: 70, width: 20, height: 40 },
    { left: 120, top: 120, width: 60, height: 40 },
  ], pageBox)).toEqual([
    { x: 0.1, y: 0.05, w: 0.1, h: 0.1 },
    { x: 0.95, y: 0.05, w: 0.05, h: 0.1 },
    { x: 0.1, y: 0.175, w: 0.3, h: 0.1 },
  ]);
});

it('computes a stable character offset across text-layer spans', () => {
  const layer = document.createElement('div');
  layer.innerHTML = '<span>Hello </span><span>brave </span><span>world</span>';
  expect(pageTextOf(layer)).toBe('Hello brave world');
  const textNode = layer.querySelectorAll('span')[2]!.firstChild!;
  const range = document.createRange();
  range.setStart(textNode, 3);
  range.setEnd(textNode, 5);
  expect(charOffsetForRange(layer, range)).toBe(15); // "Hello brave " = 12 chars, + 3 into "world"
});

it('returns no rects when the selection is outside the page', () => {
  expect(rectsFromClientRects([], { left: 0, top: 0, width: 100, height: 100 })).toEqual([]);
});
