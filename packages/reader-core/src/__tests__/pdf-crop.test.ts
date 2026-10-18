import { expect, it } from 'vitest';
import { detectCropMargins } from '../pdf/crop';

it('finds the non-white content box as fractional margins', () => {
  const width = 10, height = 10;
  const pixels = new Uint8ClampedArray(width * height * 4).fill(255);
  for (let y = 1; y <= 8; y += 1) {
    for (let x = 2; x <= 7; x += 1) {
      const i = (y * width + x) * 4;
      pixels[i] = 0; pixels[i + 1] = 0; pixels[i + 2] = 0; pixels[i + 3] = 255;
    }
  }
  expect(detectCropMargins(pixels, width, height)).toEqual({
    top: 0.1, right: 0.2, bottom: 0.1, left: 0.2,
  });
});

it('returns zero margins for an all-white page', () => {
  expect(detectCropMargins(new Uint8ClampedArray(100 * 4).fill(255), 10, 10))
    .toEqual({ top: 0, right: 0, bottom: 0, left: 0 });
});
