/** Fractional margins cropped from each side of a page, each in `[0, 1)`. */
export interface CropMargins {
  top: number;
  right: number;
  bottom: number;
  left: number;
}

/** Pixels with a luminance below this value count as ink. */
export const DEFAULT_CROP_THRESHOLD = 245;

const ZERO_MARGINS: CropMargins = Object.freeze({ top: 0, right: 0, bottom: 0, left: 0 });

function zeroMargins(): CropMargins {
  return { ...ZERO_MARGINS };
}

/**
 * Finds the non-white content box in an RGBA pixel buffer and returns the
 * white margins as fractions of the page size.
 *
 * Luminance below `threshold` marks ink; alpha is ignored because pdf.js paints
 * onto an opaque white canvas. A page with no ink keeps all four margins at
 * zero, which readers interpret as "nothing to crop".
 */
export function detectCropMargins(
  pixels: Uint8ClampedArray,
  width: number,
  height: number,
  threshold = DEFAULT_CROP_THRESHOLD,
): CropMargins {
  if (!(width > 0) || !(height > 0) || pixels.length < 4) {
    return zeroMargins();
  }

  const limit = Number.isFinite(threshold) ? threshold : DEFAULT_CROP_THRESHOLD;
  let minX = width;
  let minY = height;
  let maxX = -1;
  let maxY = -1;

  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const index = (y * width + x) * 4;
      if (index + 2 >= pixels.length) {
        break;
      }
      // Rec. 601 luma, matching how a grayscale preview would look.
      const luminance = 0.299 * pixels[index]! + 0.587 * pixels[index + 1]! + 0.114 * pixels[index + 2]!;
      if (luminance < limit) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }

  if (maxX < 0 || maxY < 0) {
    return zeroMargins();
  }

  return {
    top: minY / height,
    right: (width - 1 - maxX) / width,
    bottom: (height - 1 - maxY) / height,
    left: minX / width,
  };
}
