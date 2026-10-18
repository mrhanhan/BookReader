import type { LocatorRect } from '@bookr/shared';

import type { OpenReaderOptions } from '../types';

const DEFAULT_CMAP_URL = '/cmaps/';
const DEFAULT_STANDARD_FONT_DATA_URL = '/standard_fonts/';
/** Visual blocks never render smaller than this CSS width, even before layout. */
const MIN_PAGE_CSS_WIDTH = 640;
/** Full-page bitmaps kept in memory; older pages re-render when revisited. */
const MAX_CACHED_PAGES = 8;

/** A page as the painter needs it; mirrors the pdf.js surface used here. */
export interface PainterPage {
  getViewport(params: { scale: number }): { width: number; height: number };
  render(params: {
    canvasContext: CanvasRenderingContext2D;
    viewport: unknown;
  }): { promise: Promise<void>; cancel(): void };
}

export interface PainterDocument {
  numPages: number;
  getPage(page: number): Promise<PainterPage>;
}

export interface SourcePagePainterLike {
  load(url: string): Promise<void>;
  paint(page: number, rect: LocatorRect, canvas: HTMLCanvasElement): Promise<void>;
  destroy(): Promise<void>;
}

/** Loads a pdf.js document; injectable so hosts can reuse their own loader. */
export type PainterDocumentLoader = (
  url: string,
  options: OpenReaderOptions,
) => Promise<PainterDocument>;

/** A loaded document that can be released again when the painter goes away. */
type LoadedPainterDocument = PainterDocument & {
  destroy?: () => Promise<void> | void;
  cleanup?: () => void;
};

function finiteOrZero(value: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/**
 * Converts a normalized page rect into source pixels inside a bitmap.
 *
 * Every component is clamped independently, so a rect that overhangs the page
 * is trimmed instead of sampling outside the bitmap.
 */
export function normalizedCrop(
  rect: LocatorRect,
  width: number,
  height: number,
): { sx: number; sy: number; sw: number; sh: number } {
  const bitmapWidth = Math.max(0, finiteOrZero(width));
  const bitmapHeight = Math.max(0, finiteOrZero(height));

  const sx = clamp(finiteOrZero(rect?.x) * bitmapWidth, 0, bitmapWidth);
  const sy = clamp(finiteOrZero(rect?.y) * bitmapHeight, 0, bitmapHeight);
  const sw = clamp(finiteOrZero(rect?.w) * bitmapWidth, 0, bitmapWidth - sx);
  const sh = clamp(finiteOrZero(rect?.h) * bitmapHeight, 0, bitmapHeight - sy);

  return { sx, sy, sw, sh };
}

/** Default loader: pdf.js is imported lazily, so reflow-only hosts never load it. */
async function loadPdfDocument(
  url: string,
  options: OpenReaderOptions,
): Promise<LoadedPainterDocument> {
  const pdfjs = await import('pdfjs-dist');
  if (options.workerSrc) {
    pdfjs.GlobalWorkerOptions.workerSrc = options.workerSrc;
  }
  const loadingTask = pdfjs.getDocument({
    url,
    cMapUrl: options.cMapUrl ?? DEFAULT_CMAP_URL,
    cMapPacked: true,
    standardFontDataUrl: options.standardFontDataUrl ?? DEFAULT_STANDARD_FONT_DATA_URL,
  });
  const document = await loadingTask.promise;
  return {
    numPages: document.numPages,
    getPage: (pageNumber: number) =>
      document.getPage(pageNumber) as unknown as Promise<PainterPage>,
    destroy: () => loadingTask.destroy(),
  };
}

function devicePixelRatioOf(canvas: HTMLCanvasElement): number {
  const ratio = canvas.ownerDocument?.defaultView?.devicePixelRatio ?? 1;
  return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
}

/** Releases a lazy-loaded document, swallowing worker teardown failures. */
async function releaseDocument(
  document: LoadedPainterDocument | null | undefined,
): Promise<void> {
  if (!document) {
    return;
  }
  try {
    if (typeof document.destroy === 'function') {
      await document.destroy();
    } else if (typeof document.cleanup === 'function') {
      document.cleanup();
    }
  } catch {
    // The worker may already be gone.
  }
}

/**
 * Paints crops of the original PDF page behind reflow visual blocks.
 *
 * Full pages are rendered at device-pixel resolution and cached in an LRU of
 * eight pages, so several visual blocks from the same page share one pdf.js
 * render and long books do not retain every bitmap. Concurrent paints
 * await the same in-flight promise. A generation token invalidates every async
 * step on `destroy`, keeping a torn-down painter away from the DOM.
 */
export class SourcePagePainter implements SourcePagePainterLike {
  private readonly options: OpenReaderOptions;
  private readonly loadDocument: PainterDocumentLoader | undefined;

  private url: string | null = null;
  private document: LoadedPainterDocument | null = null;
  private documentPromise: Promise<LoadedPainterDocument> | null = null;
  private readonly pages = new Map<number, HTMLCanvasElement>();
  private readonly pagePromises = new Map<number, Promise<HTMLCanvasElement>>();
  private readonly renderTasks = new Set<{ cancel(): void }>();
  private generation = 0;
  private destroyed = false;

  constructor(options: OpenReaderOptions, loadDocument?: PainterDocumentLoader) {
    this.options = options ?? {};
    this.loadDocument = loadDocument;
  }

  async load(url: string): Promise<void> {
    if (this.destroyed) {
      throw new Error('The page painter was destroyed');
    }
    this.url = url;
    await this.ensureDocument(url);
  }

  private ensureDocument(url: string): Promise<LoadedPainterDocument> {
    if (this.documentPromise) {
      return this.documentPromise;
    }
    const generation = this.generation;
    const promise = (async () => {
      const loaded = this.loadDocument
        ? await this.loadDocument(url, this.options)
        : await loadPdfDocument(url, this.options);
      if (generation !== this.generation) {
        // destroy() won the race. Release the document that just arrived so
        // the pdf.js worker and its buffers do not outlive the painter.
        await releaseDocument(loaded as LoadedPainterDocument);
        throw new Error('The page painter was destroyed');
      }
      this.document = loaded as LoadedPainterDocument;
      return this.document;
    })();
    this.documentPromise = promise;
    return promise;
  }

  async paint(
    pageNumber: number,
    rect: LocatorRect,
    canvas: HTMLCanvasElement,
  ): Promise<void> {
    if (this.destroyed) {
      throw new Error('The page painter was destroyed');
    }
    const url = this.url;
    if (!url) {
      throw new Error('No PDF document is loaded');
    }

    const generation = this.generation;
    const document = await this.ensureDocument(url);
    if (generation !== this.generation) {
      throw new Error('The page painter was destroyed');
    }

    const count = Math.max(1, Math.floor(document.numPages));
    const page = clamp(Math.floor(pageNumber), 1, count);
    const pageProxy = await document.getPage(page);
    if (generation !== this.generation) {
      throw new Error('The page painter was destroyed');
    }

    const cssWidth = Math.max(canvas.clientWidth || 0, MIN_PAGE_CSS_WIDTH);
    const dpr = devicePixelRatioOf(canvas);
    const targetWidth = Math.max(1, Math.round(cssWidth * dpr));
    const fullPage = await this.fullPage(pageProxy, page, targetWidth, canvas.ownerDocument);
    if (generation !== this.generation) {
      throw new Error('The page painter was destroyed');
    }

    const base = pageProxy.getViewport({ scale: 1 });
    const pageAspect = base.width > 0 ? base.height / base.width : 1;
    const ratio = rect.w > 0 ? rect.h / rect.w : 0;
    // The crop describes a normalized region, so the page's own aspect ratio
    // converts the block's normalized w/h into its physical on-screen aspect.
    const targetHeight = Math.max(1, Math.round(targetWidth * ratio * pageAspect));

    canvas.width = targetWidth;
    canvas.height = targetHeight;
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas is unavailable');
    }

    const crop = normalizedCrop(rect, fullPage.width, fullPage.height);
    if (!(crop.sw > 0) || !(crop.sh > 0)) {
      throw new Error('Empty page region');
    }

    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);
    context.drawImage(
      fullPage,
      crop.sx,
      crop.sy,
      crop.sw,
      crop.sh,
      0,
      0,
      canvas.width,
      canvas.height,
    );
  }

  /** Full-page bitmap for `page`, shared by every visual block on that page. */
  private fullPage(
    page: PainterPage,
    pageNumber: number,
    targetWidth: number,
    ownerDocument: Document,
  ): Promise<HTMLCanvasElement> {
    const cached = this.pages.get(pageNumber);
    if (cached) {
      // Refresh LRU order: a revisited page is the most recently used.
      this.cachePage(pageNumber, cached);
      return Promise.resolve(cached);
    }
    const inFlight = this.pagePromises.get(pageNumber);
    if (inFlight) {
      return inFlight;
    }

    const promise = this.renderFullPage(page, targetWidth, ownerDocument)
      .then((canvas) => {
        this.cachePage(pageNumber, canvas);
        return canvas;
      })
      .finally(() => {
        this.pagePromises.delete(pageNumber);
      });
    this.pagePromises.set(pageNumber, promise);
    return promise;
  }

  /** Stores a page bitmap, evicting the least recently used pages beyond the cap. */
  private cachePage(pageNumber: number, canvas: HTMLCanvasElement): void {
    this.pages.delete(pageNumber);
    this.pages.set(pageNumber, canvas);
    while (this.pages.size > MAX_CACHED_PAGES) {
      const oldest = this.pages.keys().next().value as number | undefined;
      if (oldest === undefined) {
        break;
      }
      this.pages.delete(oldest);
    }
  }

  private async renderFullPage(
    page: PainterPage,
    targetWidth: number,
    ownerDocument: Document,
  ): Promise<HTMLCanvasElement> {
    const base = page.getViewport({ scale: 1 });
    if (!(base.width > 0) || !(base.height > 0)) {
      throw new Error('Invalid page size');
    }
    const viewport = page.getViewport({ scale: targetWidth / base.width });

    const canvas = ownerDocument.createElement('canvas');
    canvas.width = Math.max(1, Math.round(viewport.width));
    canvas.height = Math.max(1, Math.round(viewport.height));
    const context = canvas.getContext('2d');
    if (!context) {
      throw new Error('Canvas is unavailable');
    }

    const task = page.render({ canvasContext: context, viewport });
    this.renderTasks.add(task);
    try {
      await task.promise;
    } finally {
      this.renderTasks.delete(task);
    }
    return canvas;
  }

  async destroy(): Promise<void> {
    if (this.destroyed) {
      return;
    }
    this.destroyed = true;
    this.generation += 1;

    for (const task of this.renderTasks) {
      try {
        task.cancel();
      } catch {
        // A finished render cannot be cancelled; teardown stays best-effort.
      }
    }
    this.renderTasks.clear();
    this.pages.clear();
    this.pagePromises.clear();

    const document = this.document;
    this.document = null;
    this.documentPromise = null;
    this.url = null;

    await releaseDocument(document);
  }
}
