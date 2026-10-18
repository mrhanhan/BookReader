import { z } from 'zod';
import type { BookFormat } from './schemas/books';

/** Engine used to render a book: the PDF viewer or a reflowable EPUB reader. */
export type ReaderKind = 'pdf' | 'epub';

/** PDFs render natively; every other supported format is converted to EPUB. */
export function readerKindForFormat(format: BookFormat): ReaderKind {
  return format === 'pdf' ? 'pdf' : 'epub';
}

/** A rectangle in normalized page coordinates: origin top-left, values in [0, 1]. */
export const rectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .superRefine((rect, ctx) => {
    // Rects describe page-local areas, so they must stay inside the page bounds.
    if (rect.x + rect.w > 1) {
      ctx.addIssue({ code: 'custom', path: ['w'], message: 'x + w must not exceed 1' });
    }
    if (rect.y + rect.h > 1) {
      ctx.addIssue({ code: 'custom', path: ['h'], message: 'y + h must not exceed 1' });
    }
  });

export type LocatorRect = z.infer<typeof rectSchema>;

const pdfLocatorSchema = z.object({
  kind: z.literal('pdf'),
  page: z.number().int().min(1),
  percent: z.number().min(0).max(1),
  rect: rectSchema.optional(),
  rects: z.array(rectSchema).max(200).optional(),
  charOffset: z.number().int().min(0).optional(),
});

const epubLocatorSchema = z.object({
  kind: z.literal('epub'),
  cfi: z.string().min(1).max(1024),
  percent: z.number().min(0).max(1),
  href: z.string().min(1).max(1024).optional(),
});

const charRangeSchema = z
  .tuple([z.number().int().min(0), z.number().int().min(0)])
  .superRefine((range, ctx) => {
    if (range[0] > range[1]) {
      ctx.addIssue({ code: 'custom', path: [1], message: 'charRange start must not exceed end' });
    }
  });

const reflowRangeSchema = z.object({
  blockId: z.string().min(1).max(200),
  charRange: charRangeSchema,
});

const reflowLocatorSchema = z.object({
  kind: z.literal('reflow'),
  sourcePage: z.number().int().min(1),
  percent: z.number().min(0).max(1),
  blockId: z.string().min(1).max(200).optional(),
  charRange: charRangeSchema.optional(),
  /** Character ranges across several blocks, used for cross-block highlights. */
  ranges: z.array(reflowRangeSchema).max(200).optional(),
});

/** Discriminated position of a reading location inside a book. */
export const locatorSchema = z.discriminatedUnion('kind', [
  pdfLocatorSchema,
  epubLocatorSchema,
  reflowLocatorSchema,
]);

export type PdfLocator = z.infer<typeof pdfLocatorSchema>;
export type EpubLocator = z.infer<typeof epubLocatorSchema>;
export type ReflowLocator = z.infer<typeof reflowLocatorSchema>;
export type Locator = z.infer<typeof locatorSchema>;

// Normalized coordinates are stored with micrometer precision; rounding here removes
// floating-point noise introduced while adding or subtracting page fractions.
const COORDINATE_PRECISION = 1e6;

function roundCoordinate(value: number): number {
  return Math.round(value * COORDINATE_PRECISION) / COORDINATE_PRECISION;
}

/** Returns the bounding rect around all given rects, or null when there are none. */
export function unionRects(rects: LocatorRect[]): LocatorRect | null {
  if (rects.length === 0) {
    return null;
  }

  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;

  for (const rect of rects) {
    minX = Math.min(minX, rect.x);
    minY = Math.min(minY, rect.y);
    maxX = Math.max(maxX, rect.x + rect.w);
    maxY = Math.max(maxY, rect.y + rect.h);
  }

  const x = roundCoordinate(minX);
  const y = roundCoordinate(minY);

  return {
    x,
    y,
    w: roundCoordinate(roundCoordinate(maxX) - x),
    h: roundCoordinate(roundCoordinate(maxY) - y),
  };
}
