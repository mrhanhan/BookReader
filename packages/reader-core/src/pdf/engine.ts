import type { Locator, LocatorRect, PdfLocator } from '@bookr/shared';
import { unionRects } from '@bookr/shared';
import {
  getDocument,
  GlobalWorkerOptions,
  TextLayer,
  type PDFDocumentLoadingTask,
  type PDFDocumentProxy,
  type PDFPageProxy,
  type RenderTask,
} from 'pdfjs-dist';

import { TypedEmitter } from '../emitter';
import { clamp, pageForPercent, percentForPage } from '../locator';
import { HIGHLIGHT_HEX } from '../settings';
import type {
  OpenReaderOptions,
  PdfLayoutMode,
  ReaderDocumentInfo,
  ReaderEngine,
  ReaderEventMap,
  ReaderHighlight,
  ReaderSelection,
  ReaderSettings,
  TocItem,
} from '../types';
import { detectCropMargins, type CropMargins } from './crop';
import {
  DEFAULT_PAGE_PADDING,
  FOCUS_RATIO,
  computeScale,
  focusScrollTop,
  pageFromScroll,
  pagesToRenderInitially,
  type PageSize,
} from './layout';
import { buildPdfToc, type PdfOutlineNode } from './outline';
import { rectsFromClientRects } from './selection';
import { charOffsetForRange, pageTextOf } from './text-layer';

/** Auto-detected margins are trusted only up to 15% per side. */
const AUTO_CROP_LIMIT = 0.15;
/** Crop detection renders page 1 at this width, then reads the pixels back. */
const CROP_PREVIEW_WIDTH = 200;
/** At most 90% of an axis may be cropped, keeping a visible sliver. */
const CROP_COVERAGE_LIMIT = 0.9;
/** Rendered pages outside this window are unloaded again. */
const MAX_RENDERED_PAGES = 6;
const SELECTION_DEBOUNCE_MS = 60;
/** Hard cap from the shared locator schema. */
const MAX_SELECTION_RECTS = 200;
const FLASH_DURATION_MS = 1200;
const SPREAD_GAP = 12;
const CONTINUOUS_GAP = 16;
const OBSERVER_ROOT_MARGIN = '150% 0px';
/** Minimum percentage movement that warrants a new `relocated` event. */
const RELOCATION_EPSILON = 0.0005;
const DEFAULT_CMAP_URL = '/cmaps/';
const DEFAULT_STANDARD_FONT_DATA_URL = '/standard_fonts/';

function zeroCrop(): CropMargins {
  return { top: 0, right: 0, bottom: 0, left: 0 };
}

/** Caps a pair of opposing margins so the visible axis never collapses. */
function capPair(first: number, second: number): [number, number] {
  const a = clamp(Number.isFinite(first) ? first : 0, 0, 1);
  const b = clamp(Number.isFinite(second) ? second : 0, 0, 1);
  const total = a + b;
  if (total <= CROP_COVERAGE_LIMIT) {
    return [a, b];
  }
  const factor = CROP_COVERAGE_LIMIT / total;
  return [a * factor, b * factor];
}

function sameCropAdjust(
  left: ReaderSettings['pdf']['cropAdjust'],
  right: ReaderSettings['pdf']['cropAdjust'],
): boolean {
  return left.top === right.top && left.right === right.right
    && left.bottom === right.bottom && left.left === right.left;
}

function pageLocator(page: number, pageCount: number): PdfLocator {
  return { kind: 'pdf', page, percent: percentForPage(page, pageCount) };
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Unknown PDF error';
}

function isCancellation(error: unknown): boolean {
  const name = typeof error === 'object' && error !== null
    ? (error as { name?: unknown }).name
    : undefined;
  return name === 'RenderingCancelledException' || name === 'AbortException';
}

/** Sets the worker URL only when the host supplied one. */
function configureWorker(workerSrc: string | undefined): void {
  if (workerSrc) {
    GlobalWorkerOptions.workerSrc = workerSrc;
  }
}

type PdfHighlight = ReaderHighlight & { locator: PdfLocator };

interface PageSlot {
  readonly pageNumber: number;
  /** This page's own base viewport size; pages need not share page 1's size. */
  baseWidth: number;
  baseHeight: number;
  readonly outer: HTMLDivElement;
  readonly inner: HTMLDivElement;
  readonly canvas: HTMLCanvasElement;
  readonly textLayer: HTMLDivElement;
  readonly highlightLayer: HTMLDivElement;
  pageProxy: PDFPageProxy | null;
  textLayerInstance: TextLayer | null;
  renderTask: RenderTask | null;
  renderPromise: Promise<void> | null;
  renderToken: number;
  rendered: boolean;
  renderedScale: number;
}

/**
 * PDF original-layout engine backed by pdf.js.
 *
 * The engine owns the `.bookr-pdf-scroll` host and one `.bookr-pdf-page` slot
 * per page. Each slot reserves its final (cropped) size before its canvas is
 * rendered, so scrolling stays stable while pages stream in. The inner page box
 * keeps full-page coordinates, which is what selections, highlights and
 * locators are normalized against.
 */
export class PdfReaderEngine implements ReaderEngine {
  readonly kind = 'pdf' as const;

  private readonly emitter = new TypedEmitter<ReaderEventMap>();
  private readonly slots = new Map<number, PageSlot>();
  private readonly renderedPages = new Set<number>();
  private readonly visiblePages = new Set<number>();
  private readonly flashTimers = new Set<ReturnType<typeof setTimeout>>();

  private abort = new AbortController();
  private container: HTMLElement | null = null;
  private scrollHost: HTMLDivElement | null = null;
  private pagesHost: HTMLDivElement | null = null;
  private pdf: PDFDocumentProxy | null = null;
  private loadingTask: PDFDocumentLoadingTask | null = null;
  private settings: ReaderSettings | null = null;
  private pageCount = 0;
  private baseSize: PageSize = { width: 0, height: 0 };
  private detectedCrop: CropMargins = zeroCrop();
  private crop: CropMargins = zeroCrop();
  private scale = 1;
  private currentPage = 1;
  private highlights: ReaderHighlight[] = [];
  private observer: IntersectionObserver | null = null;
  private scrollFrame: number | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  private lastEmittedPage = 0;
  private lastEmittedPercent = -1;
  private layoutVersion = 0;
  private highlightsByPage = new Map<number, PdfHighlight[]>();
  private topsCache: number[] | null = null;
  private topsCacheVersion = -1;
  private geometryVersion = 0;
  private resizeObserver: ResizeObserver | null = null;

  on<K extends keyof ReaderEventMap>(
    event: K,
    listener: (payload: ReaderEventMap[K]) => void,
  ): () => void {
    return this.emitter.on(event, listener);
  }

  async open(
    url: string,
    container: HTMLElement,
    settings: ReaderSettings,
    options: OpenReaderOptions = {},
  ): Promise<ReaderDocumentInfo> {
    await this.teardown();
    this.settings = settings;
    this.container = container;
    this.abort = new AbortController();
    container.dataset.readerTheme = settings.theme;
    configureWorker(options.workerSrc);

    try {
      const loadingTask = getDocument({
        url,
        cMapUrl: options.cMapUrl ?? DEFAULT_CMAP_URL,
        cMapPacked: true,
        standardFontDataUrl: options.standardFontDataUrl ?? DEFAULT_STANDARD_FONT_DATA_URL,
      });
      this.loadingTask = loadingTask;
      const pdf = await loadingTask.promise;
      this.ensureAlive();
      this.pdf = pdf;
      this.pageCount = Math.max(1, pdf.numPages);

      const firstPage = await pdf.getPage(1);
      this.ensureAlive();
      const base = firstPage.getViewport({ scale: 1 });
      this.baseSize = { width: base.width, height: base.height };
      this.detectedCrop = settings.pdf.crop === 'auto'
        ? await this.detectCrop(firstPage)
        : zeroCrop();
      this.ensureAlive();
      this.crop = this.effectiveCrop(settings);

      this.buildDom(container);
      // In paged modes the whole opening spread is created and painted before
      // `open` resolves; a single-page first paint would leave the facing page
      // blank until the reader navigates.
      const openingPages = this.mode === 'continuous'
        ? [1]
        : pagesToRenderInitially(this.mode, this.currentPage, this.pageCount);
      this.rebuildLayout(this.mode === 'continuous' ? undefined : openingPages);
      this.attachListeners();

      // Start the first spread's paint before waiting on metadata and the
      // outline; a large outline must not delay the reader. A page that fails
      // to render reports `render-failed` but must not fail the whole open.
      const firstRender = Promise.all(
        openingPages.map((pageNumber) =>
          this.renderPage(pageNumber).catch((error) => this.emitRenderFailure(error)),
        ),
      );
      const [title, toc] = await Promise.all([this.readTitle(), this.readToc()]);
      this.ensureAlive();
      await firstRender;
      this.ensureAlive();

      if (options.initialLocator && options.initialLocator.kind === 'pdf') {
        await this.goTo(options.initialLocator);
      } else {
        this.emitRelocated();
      }

      return { kind: 'pdf', title, pageCount: this.pageCount, toc };
    } catch (error) {
      if (this.abort.signal.aborted) {
        // destroy() won the race; the caller asked for teardown, not a failure.
        throw new Error('The reader was destroyed while opening');
      }
      const message = readableError(error);
      this.emitter.emit('error', { code: 'load-failed', message });
      await this.teardown();
      throw new Error(`Failed to open the PDF: ${message}`);
    }
  }

  private ensureAlive(): void {
    if (this.abort.signal.aborted) {
      throw new Error('The reader was destroyed while opening');
    }
  }

  async goTo(locator: Locator, options: { flash?: boolean } = {}): Promise<void> {
    if (!this.pdf) {
      throw new Error('Reader is not open');
    }
    // Reflow locators carry their source page; the original view can honour
    // that page even though it has no block geometry to restore.
    let normalized: PdfLocator;
    if (locator.kind === 'reflow') {
      normalized = {
        kind: 'pdf',
        page: clamp(
          Math.floor(locator.sourcePage),
          1,
          Math.max(1, this.pageCount),
        ),
        percent: locator.percent,
      };
    } else if (locator.kind === 'pdf') {
      normalized = locator;
    } else {
      throw new Error('The PDF reader cannot open a non-PDF locator');
    }

    const count = Math.max(1, this.pageCount);
    const page = clamp(Math.floor(normalized.page), 1, count);
    this.currentPage = page;

    if (this.mode === 'continuous') {
      const host = this.scrollHost;
      const slot = this.slots.get(page);
      if (host && slot) {
        const hostRect = host.getBoundingClientRect();
        const pageTop = slot.outer.getBoundingClientRect().top - hostRect.top + host.scrollTop;
        // A locator rect lands on the focus line; a bare page jump stays at the top.
        const target = focusScrollTop({
          pageTop,
          pageHeight: slot.outer.offsetHeight,
          viewportHeight: host.clientHeight,
          rectY: normalized.rect?.y,
          cropTop: this.crop.top,
          cropBottom: this.crop.bottom,
        });
        const maxScroll = Math.max(0, host.scrollHeight - host.clientHeight);
        host.scrollTo({ top: clamp(target, 0, maxScroll), behavior: 'auto' });
      }
      await this.renderPage(page);
    } else {
      this.createPagedSlots();
      await Promise.all([...this.slots.keys()].map((pageNumber) => this.renderPage(pageNumber)));
    }

    if (options.flash) {
      this.flash(page, normalized.rect);
    }
    this.emitRelocated(this.currentLocator());
  }

  async goToPercent(percent: number): Promise<void> {
    if (!this.pdf) {
      throw new Error('Reader is not open');
    }
    const value = clamp(Number.isFinite(percent) ? percent : 0, 0, 1);
    const page = pageForPercent(value, this.pageCount);
    const fraction = clamp(value * Math.max(1, this.pageCount) - (page - 1), 0, 1);
    const locator: PdfLocator = { kind: 'pdf', page, percent: value };
    if (fraction > 0) {
      locator.rect = { x: 0, y: fraction, w: 0, h: 0 };
    }
    await this.goTo(locator);
  }

  async next(): Promise<void> {
    if (!this.pdf) {
      throw new Error('Reader is not open');
    }
    if (this.mode === 'continuous') {
      const host = this.scrollHost;
      if (host) {
        host.scrollBy({ top: host.clientHeight * 0.85, behavior: 'auto' });
        this.updateFromScroll();
      }
      return;
    }

    const count = Math.max(1, this.pageCount);
    if (this.mode === 'double') {
      const pages = pagesToRenderInitially('double', this.currentPage, count);
      const target = (pages[pages.length - 1] ?? this.currentPage) + 1;
      if (target > count) {
        return;
      }
      await this.goTo(pageLocator(target, count));
      return;
    }

    const target = clamp(this.currentPage + 1, 1, count);
    await this.goTo(pageLocator(target, count));
  }

  async previous(): Promise<void> {
    if (!this.pdf) {
      throw new Error('Reader is not open');
    }
    if (this.mode === 'continuous') {
      const host = this.scrollHost;
      if (host) {
        host.scrollBy({ top: -host.clientHeight * 0.85, behavior: 'auto' });
        this.updateFromScroll();
      }
      return;
    }

    const count = Math.max(1, this.pageCount);
    if (this.mode === 'double') {
      const first = pagesToRenderInitially('double', this.currentPage, count)[0] ?? 1;
      const target = first - 1;
      if (target < 1) {
        return;
      }
      await this.goTo(pageLocator(target, count));
      return;
    }

    const target = Math.max(1, this.currentPage - 1);
    await this.goTo(pageLocator(target, count));
  }

  currentLocator(): Locator {
    return this.pdfLocatorNow();
  }

  private pdfLocatorNow(precomputedTops?: number[]): PdfLocator {
    if (!this.pdf) {
      throw new Error('Reader is not open');
    }

    const count = Math.max(1, this.pageCount);
    let page = clamp(Math.floor(this.currentPage), 1, count);
    let fraction = 0;

    if (this.mode === 'continuous') {
      const host = this.scrollHost;
      if (host) {
        const tops = precomputedTops ?? this.pageTops();
        page = pageFromScroll(host.scrollTop, tops, host.clientHeight);
        this.currentPage = page;

        const slot = this.slots.get(page);
        const top = tops[page - 1];
        if (slot && top !== undefined) {
          const height = slot.outer.offsetHeight;
          if (height > 0) {
            const focus = host.scrollTop + host.clientHeight * FOCUS_RATIO;
            const visibleFraction = clamp((focus - top) / height, 0, 1);
            // Report the full-page fraction so cropping never moves a locator.
            fraction = clamp(
              this.crop.top + visibleFraction * (1 - this.crop.top - this.crop.bottom),
              0,
              1,
            );
          }
        }
      }
    }

    const locator: PdfLocator = {
      kind: 'pdf',
      page,
      percent: percentForPage(page, count, fraction),
    };
    if (fraction > 0) {
      locator.rect = { x: 0, y: fraction, w: 0, h: 0 };
    }
    return locator;
  }

  setSettings(settings: ReaderSettings): void {
    const previous = this.settings;
    this.settings = settings;
    if (this.container) {
      this.container.dataset.readerTheme = settings.theme;
    }
    if (!previous || !this.pdf) {
      return;
    }

    const pdfChanged = previous.pdf.mode !== settings.pdf.mode
      || previous.pdf.zoom !== settings.pdf.zoom
      || previous.pdf.crop !== settings.pdf.crop
      || !sameCropAdjust(previous.pdf.cropAdjust, settings.pdf.cropAdjust);
    if (!pdfChanged) {
      return;
    }

    let locator: Locator;
    try {
      locator = this.currentLocator();
    } catch {
      locator = pageLocator(this.currentPage, this.pageCount);
    }
    const redetectCrop = previous.pdf.crop !== settings.pdf.crop;
    void this.relayout(redetectCrop, locator);
  }

  setHighlights(highlights: ReaderHighlight[]): void {
    this.highlights = Array.isArray(highlights) ? highlights.slice() : [];
    this.highlightsByPage = new Map();
    for (const highlight of this.highlights) {
      const { locator } = highlight;
      if (locator.kind !== 'pdf') {
        continue;
      }
      const pdfHighlight: PdfHighlight = { ...highlight, locator };
      let group = this.highlightsByPage.get(locator.page);
      if (!group) {
        group = [];
        this.highlightsByPage.set(locator.page, group);
      }
      group.push(pdfHighlight);
    }
    for (const slot of this.slots.values()) {
      this.paintHighlightsForSlot(slot);
    }
  }

  async destroy(): Promise<void> {
    await this.teardown();
    this.emitter.clear();
  }

  private get mode(): PdfLayoutMode {
    return this.settings?.pdf.mode ?? 'continuous';
  }

  private async teardown(): Promise<void> {
    this.abort.abort();
    this.layoutVersion += 1;
    if (this.scrollFrame !== null) {
      this.cancelFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    if (this.selectionTimer !== null) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
    for (const timer of this.flashTimers) {
      clearTimeout(timer);
    }
    this.flashTimers.clear();
    this.observer?.disconnect();
    this.observer = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;

    for (const slot of this.slots.values()) {
      this.cancelSlot(slot);
    }
    this.slots.clear();
    this.renderedPages.clear();
    this.visiblePages.clear();
    this.pagesHost?.replaceChildren();

    const pdf = this.pdf;
    const loadingTask = this.loadingTask;
    this.pdf = null;
    this.loadingTask = null;
    try {
      if (loadingTask) {
        await loadingTask.destroy();
      } else if (pdf) {
        pdf.cleanup();
      }
    } catch {
      // The worker may already be gone; teardown stays best-effort.
    }

    this.container?.replaceChildren();
    this.container = null;
    this.scrollHost = null;
    this.pagesHost = null;
    this.settings = null;
    this.pageCount = 0;
    this.currentPage = 1;
    this.scale = 1;
    this.baseSize = { width: 0, height: 0 };
    this.detectedCrop = zeroCrop();
    this.crop = zeroCrop();
    this.highlights = [];
    this.highlightsByPage.clear();
    this.topsCache = null;
    this.topsCacheVersion = -1;
    this.geometryVersion += 1;
    this.lastEmittedPage = 0;
    this.lastEmittedPercent = -1;
  }

  private invalidateTops(): void {
    this.topsCache = null;
    this.geometryVersion += 1;
  }

  private buildDom(container: HTMLElement): void {
    container.replaceChildren();

    const scrollHost = document.createElement('div');
    scrollHost.className = 'bookr-pdf-scroll';
    scrollHost.style.position = 'relative';
    scrollHost.style.width = '100%';
    scrollHost.style.height = '100%';
    scrollHost.style.overflow = 'auto';
    scrollHost.style.overflowAnchor = 'none';
    scrollHost.tabIndex = 0;

    const pagesHost = document.createElement('div');
    pagesHost.className = 'bookr-pdf-pages';
    scrollHost.append(pagesHost);
    container.append(scrollHost);

    this.scrollHost = scrollHost;
    this.pagesHost = pagesHost;
  }

  private attachListeners(): void {
    const doc = this.container?.ownerDocument;
    const scrollHost = this.scrollHost;
    if (doc) {
      doc.addEventListener('selectionchange', this.handleSelectionChange, { signal: this.abort.signal });
    }
    if (scrollHost) {
      scrollHost.addEventListener('scroll', this.handleScroll, { passive: true, signal: this.abort.signal });
    }
    if (scrollHost && typeof ResizeObserver !== 'undefined') {
      const resizeObserver = new ResizeObserver(() => {
        this.invalidateTops();
      });
      resizeObserver.observe(scrollHost);
      this.resizeObserver = resizeObserver;
    }
  }

  private rebuildLayout(initialPages?: number[]): void {
    const pagesHost = this.pagesHost;
    const scrollHost = this.scrollHost;
    if (!pagesHost || !scrollHost || !this.pdf) {
      return;
    }

    const mode = this.mode;
    pagesHost.style.display = 'flex';
    pagesHost.style.flexDirection = mode === 'continuous' ? 'column' : 'row';
    // "safe center" aligns to the start edge when a page is wider than the
    // viewport, so oversized numeric zoom never hides the left margin.
    pagesHost.style.alignItems = mode === 'continuous' ? 'safe center' : 'center';
    pagesHost.style.justifyContent = mode === 'continuous' ? 'flex-start' : 'safe center';
    pagesHost.style.boxSizing = 'border-box';
    pagesHost.style.width = '100%';
    pagesHost.style.gap = mode === 'double'
      ? `${SPREAD_GAP}px`
      : mode === 'continuous' ? `${CONTINUOUS_GAP}px` : '0';
    pagesHost.style.minHeight = mode === 'continuous' ? '0' : '100%';
    pagesHost.style.padding = mode === 'continuous' ? '16px 0' : '0';

    this.observer?.disconnect();
    this.observer = null;
    for (const slot of this.slots.values()) {
      this.cancelSlot(slot);
    }
    this.slots.clear();
    this.renderedPages.clear();
    this.visiblePages.clear();
    pagesHost.replaceChildren();
    this.invalidateTops();

    this.updateScale();

    if (mode === 'continuous') {
      for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
        const slot = this.createSlot(pageNumber);
        this.slots.set(pageNumber, slot);
        pagesHost.append(slot.outer);
      }
      this.observeSlots();
    } else {
      this.createPagedSlots(initialPages);
    }
  }

  private createPagedSlots(pages?: number[]): void {
    const pagesHost = this.pagesHost;
    if (!pagesHost) {
      return;
    }

    for (const slot of this.slots.values()) {
      this.cancelSlot(slot);
    }
    this.slots.clear();
    this.renderedPages.clear();
    this.visiblePages.clear();
    pagesHost.replaceChildren();

    for (const pageNumber of pages ?? this.pagesForCurrent()) {
      const slot = this.createSlot(pageNumber);
      this.slots.set(pageNumber, slot);
      pagesHost.append(slot.outer);
    }
  }

  private pagesForCurrent(): number[] {
    const count = Math.max(1, this.pageCount);
    const current = clamp(Math.floor(this.currentPage), 1, count);
    return pagesToRenderInitially(this.mode, current, count);
  }

  private updateScale(): void {
    const settings = this.settings;
    if (!settings) {
      return;
    }
    const viewport = this.viewportSize();
    const cropped: PageSize = {
      width: Math.max(1, this.baseSize.width * (1 - this.crop.left - this.crop.right)),
      height: Math.max(1, this.baseSize.height * (1 - this.crop.top - this.crop.bottom)),
    };
    const availableWidth = this.mode === 'double'
      ? Math.max(1, viewport.width - SPREAD_GAP) / 2
      : viewport.width;

    this.scale = computeScale({
      page: cropped,
      viewport: { width: availableWidth, height: viewport.height },
      zoom: settings.pdf.zoom,
      padding: DEFAULT_PAGE_PADDING,
    });
  }

  private viewportSize(): { width: number; height: number } {
    const host = this.scrollHost;
    const width = host?.clientWidth ?? 0;
    const height = host?.clientHeight ?? 0;
    if (width > 0 && height > 0) {
      return { width, height };
    }
    const fallback = this.container?.getBoundingClientRect();
    return {
      width: Math.max(1, width || fallback?.width || 1),
      height: Math.max(1, height || fallback?.height || 1),
    };
  }

  private createSlot(pageNumber: number): PageSlot {
    const outer = document.createElement('div');
    outer.className = 'bookr-pdf-page';
    outer.dataset.page = String(pageNumber);
    outer.style.position = 'relative';
    outer.style.overflow = 'hidden';
    outer.style.flex = '0 0 auto';
    outer.style.boxSizing = 'border-box';

    const inner = document.createElement('div');
    inner.className = 'bookr-pdf-page-inner';
    inner.style.position = 'absolute';
    inner.style.left = '0';
    inner.style.top = '0';
    inner.style.transformOrigin = '0 0';

    const canvas = document.createElement('canvas');
    canvas.className = 'bookr-pdf-canvas';
    canvas.style.position = 'absolute';
    canvas.style.left = '0';
    canvas.style.top = '0';
    canvas.style.width = '100%';
    canvas.style.height = '100%';
    canvas.style.display = 'block';

    const textLayer = document.createElement('div');
    textLayer.className = 'bookr-text-layer';
    textLayer.style.position = 'absolute';
    textLayer.style.left = '0';
    textLayer.style.top = '0';
    textLayer.style.transformOrigin = '0 0';
    textLayer.style.setProperty('--scale-round-x', '1px');
    textLayer.style.setProperty('--scale-round-y', '1px');
    textLayer.style.setProperty('--total-scale-factor', String(this.scale));

    const highlightLayer = document.createElement('div');
    highlightLayer.className = 'bookr-highlight-layer';
    highlightLayer.style.position = 'absolute';
    highlightLayer.style.left = '0';
    highlightLayer.style.top = '0';
    highlightLayer.style.width = '100%';
    highlightLayer.style.height = '100%';
    highlightLayer.style.pointerEvents = 'none';

    inner.append(canvas, textLayer, highlightLayer);
    outer.append(inner);

    const slot: PageSlot = {
      pageNumber,
      baseWidth: this.baseSize.width,
      baseHeight: this.baseSize.height,
      outer,
      inner,
      canvas,
      textLayer,
      highlightLayer,
      pageProxy: null,
      textLayerInstance: null,
      renderTask: null,
      renderPromise: null,
      renderToken: 0,
      rendered: false,
      renderedScale: 0,
    };

    this.applySlotLayout(slot);
    this.paintHighlightsForSlot(slot);
    return slot;
  }

  /**
   * Sizes one page slot and applies the crop transform to its inner box.
   *
   * The inner box is the cropped layout box; `scale(sx, sy)` restores it to the
   * full page size while the parent clips it, and the translate shifts the
   * cropped origin to the top-left corner. The text layer is laid out in
   * full-page pixels, so it receives the inverse scale.
   */
  private applySlotLayout(slot: PageSlot): void {
    const { top, right, bottom, left } = this.crop;
    const visibleWidth = Math.max(1e-6, 1 - left - right);
    const visibleHeight = Math.max(1e-6, 1 - top - bottom);
    const sx = 1 / visibleWidth;
    const sy = 1 / visibleHeight;

    const baseWidth = slot.baseWidth > 0 ? slot.baseWidth : this.baseSize.width;
    const baseHeight = slot.baseHeight > 0 ? slot.baseHeight : this.baseSize.height;
    const fullWidth = baseWidth * this.scale;
    const fullHeight = baseHeight * this.scale;
    const boxWidth = fullWidth * visibleWidth;
    const boxHeight = fullHeight * visibleHeight;

    slot.outer.style.width = `${boxWidth}px`;
    slot.outer.style.height = `${boxHeight}px`;
    slot.inner.style.width = `${boxWidth}px`;
    slot.inner.style.height = `${boxHeight}px`;
    slot.inner.style.transform = `translate(${-left * boxWidth * sx}px, ${-top * boxHeight * sy}px) scale(${sx}, ${sy})`;
    slot.textLayer.style.transform = `scale(${1 / sx}, ${1 / sy})`;
    slot.textLayer.style.setProperty('--total-scale-factor', String(this.scale));
    this.invalidateTops();
  }

  private observeSlots(): void {
    const scrollHost = this.scrollHost;
    this.observer?.disconnect();
    this.observer = null;
    if (!scrollHost || typeof IntersectionObserver === 'undefined') {
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const pageNumber = Number((entry.target as HTMLElement).dataset.page);
        if (!Number.isFinite(pageNumber) || pageNumber < 1) {
          continue;
        }
        if (entry.isIntersecting) {
          this.visiblePages.add(pageNumber);
          void this.renderPage(pageNumber);
        } else {
          this.visiblePages.delete(pageNumber);
          // Away from the window, cancel in-flight work and release the bitmap.
          // The current page and its neighbours stay warm.
          if (Math.abs(pageNumber - this.currentPage) > 1) {
            const slot = this.slots.get(pageNumber);
            if (slot) {
              this.evictSlot(slot);
            }
          }
        }
      }
      this.trimRendered(this.currentPage);
    }, { root: scrollHost, rootMargin: OBSERVER_ROOT_MARGIN });

    this.observer = observer;
    for (const slot of this.slots.values()) {
      observer.observe(slot.outer);
    }
  }

  private renderPage(pageNumber: number): Promise<void> {
    const slot = this.slots.get(pageNumber);
    if (!slot) {
      return Promise.resolve();
    }
    if (slot.rendered && slot.renderedScale === this.scale) {
      return Promise.resolve();
    }
    if (slot.renderPromise) {
      return slot.renderPromise;
    }
    const promise = this.doRender(slot).finally(() => {
      slot.renderPromise = null;
    });
    slot.renderPromise = promise;
    return promise;
  }

  private async doRender(slot: PageSlot): Promise<void> {
    const pdf = this.pdf;
    if (!pdf) {
      return;
    }

    const token = slot.renderToken + 1;
    slot.renderToken = token;
    slot.renderTask?.cancel();
    slot.renderTask = null;
    slot.textLayerInstance?.cancel();
    slot.textLayerInstance = null;

    let page: PDFPageProxy;
    try {
      page = slot.pageProxy ?? await pdf.getPage(slot.pageNumber);
    } catch (error) {
      if (!isCancellation(error)) {
        this.emitRenderFailure(error);
      }
      return;
    }
    if (token !== slot.renderToken) {
      return;
    }
    slot.pageProxy = page;
    const pageBase = page.getViewport({ scale: 1 });
    this.updateSlotBaseSize(slot, pageBase.width, pageBase.height);

    const viewport = page.getViewport({ scale: this.scale });
    const dpr = this.devicePixelRatio();
    const canvas = slot.canvas;
    canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
    canvas.height = Math.max(1, Math.floor(viewport.height * dpr));

    const context = canvas.getContext('2d');
    if (!context) {
      this.emitRenderFailure(new Error('A 2D canvas context is unavailable'));
      return;
    }
    context.setTransform(1, 0, 0, 1, 0, 0);
    context.clearRect(0, 0, canvas.width, canvas.height);

    let task: RenderTask;
    try {
      task = page.render({
        canvas: null,
        canvasContext: context,
        viewport,
        transform: [dpr, 0, 0, dpr, 0, 0],
      });
    } catch (error) {
      this.emitRenderFailure(error);
      return;
    }
    slot.renderTask = task;
    try {
      await task.promise;
    } catch (error) {
      if (token === slot.renderToken && !isCancellation(error)) {
        this.emitRenderFailure(error);
      }
      return;
    } finally {
      if (slot.renderTask === task) {
        slot.renderTask = null;
      }
    }
    if (token !== slot.renderToken) {
      return;
    }

    slot.textLayer.replaceChildren();
    slot.textLayer.style.setProperty('--total-scale-factor', String(this.scale));
    try {
      slot.textLayer.style.width = `${viewport.width}px`;
      slot.textLayer.style.height = `${viewport.height}px`;
      const textLayer = new TextLayer({
        textContentSource: page.streamTextContent(),
        container: slot.textLayer,
        viewport,
      });
      slot.textLayerInstance = textLayer;
      await textLayer.render();
    } catch {
      // A broken text layer must not hide the canvas; selections simply stay unavailable.
    }
    if (token !== slot.renderToken) {
      return;
    }

    slot.textLayer.style.width = `${viewport.width}px`;
    slot.textLayer.style.height = `${viewport.height}px`;
    slot.rendered = true;
    slot.renderedScale = this.scale;
    this.renderedPages.add(slot.pageNumber);
    this.paintHighlightsForSlot(slot);
    this.trimRendered(this.currentPage);
  }

  /**
   * Applies a page's real base size to its slot. Mixed-size PDFs no longer
   * inherit page 1's aspect, and a size that changes after the placeholder was
   * reserved compensates the scroll position when the slot sits above the
   * viewport.
   */
  private updateSlotBaseSize(slot: PageSlot, width: number, height: number): void {
    if (!(width > 0) || !(height > 0)) {
      return;
    }
    if (Math.abs(slot.baseWidth - width) < 0.5 && Math.abs(slot.baseHeight - height) < 0.5) {
      return;
    }

    const host = this.scrollHost;
    const hostTop = host ? host.getBoundingClientRect().top : 0;
    const beforeTop = host ? slot.outer.getBoundingClientRect().top : 0;
    const beforeHeight = slot.outer.offsetHeight;

    slot.baseWidth = width;
    slot.baseHeight = height;
    this.applySlotLayout(slot);

    if (!host) {
      return;
    }
    const delta = slot.outer.offsetHeight - beforeHeight;
    if (delta !== 0 && beforeTop < hostTop) {
      host.scrollTop += delta;
    }
  }

  private trimRendered(anchorPage: number): void {
    if (this.renderedPages.size <= MAX_RENDERED_PAGES) {
      return;
    }

    // Enforce the cap even when several pages are technically visible at a low
    // zoom; the current page is always kept.
    const candidates = [...this.renderedPages]
      .filter((page) => page !== anchorPage)
      .sort((a, b) => Math.abs(b - anchorPage) - Math.abs(a - anchorPage));

    for (const page of candidates) {
      if (this.renderedPages.size <= MAX_RENDERED_PAGES) {
        break;
      }
      const slot = this.slots.get(page);
      if (!slot || slot.renderPromise) {
        continue;
      }
      this.evictSlot(slot);
    }
  }

  private evictSlot(slot: PageSlot): void {
    slot.renderToken += 1;
    slot.renderTask?.cancel();
    slot.renderTask = null;
    slot.textLayerInstance?.cancel();
    slot.textLayerInstance = null;
    slot.pageProxy?.cleanup();
    slot.canvas.width = 1;
    slot.canvas.height = 1;
    slot.textLayer.replaceChildren();
    slot.rendered = false;
    slot.renderedScale = 0;
    this.renderedPages.delete(slot.pageNumber);
    // The highlight layer deliberately survives eviction.
  }

  private cancelSlot(slot: PageSlot): void {
    slot.renderToken += 1;
    slot.renderTask?.cancel();
    slot.renderTask = null;
    slot.textLayerInstance?.cancel();
    slot.textLayerInstance = null;
    slot.pageProxy?.cleanup();
    slot.pageProxy = null;
    slot.canvas.width = 1;
    slot.canvas.height = 1;
    slot.textLayer.replaceChildren();
    slot.rendered = false;
    slot.renderedScale = 0;
    this.renderedPages.delete(slot.pageNumber);
  }

  private devicePixelRatio(): number {
    const ratio = this.container?.ownerDocument?.defaultView?.devicePixelRatio ?? 1;
    return Number.isFinite(ratio) && ratio > 0 ? ratio : 1;
  }

  private emitRenderFailure(error: unknown): void {
    if (isCancellation(error)) {
      return;
    }
    this.emitter.emit('error', { code: 'render-failed', message: readableError(error) });
  }

  /**
   * Content offsets of every page slot. The result only changes when slot
   * geometry changes, so it is cached per geometry version and shared by the
   * scroll handler and `currentLocator`.
   */
  private pageTops(): number[] {
    if (this.topsCache !== null && this.topsCacheVersion === this.geometryVersion) {
      return this.topsCache;
    }
    const scrollHost = this.scrollHost;
    if (!scrollHost) {
      return [];
    }
    const hostRect = scrollHost.getBoundingClientRect();
    const tops: number[] = [];
    for (let pageNumber = 1; pageNumber <= this.pageCount; pageNumber += 1) {
      const slot = this.slots.get(pageNumber);
      if (!slot) {
        tops.push(0);
        continue;
      }
      tops.push(slot.outer.getBoundingClientRect().top - hostRect.top + scrollHost.scrollTop);
    }
    this.topsCache = tops;
    this.topsCacheVersion = this.geometryVersion;
    return tops;
  }

  private updateFromScroll(): void {
    const host = this.scrollHost;
    if (!host || !this.pdf || this.mode !== 'continuous') {
      return;
    }
    const tops = this.pageTops();
    const page = pageFromScroll(host.scrollTop, tops, host.clientHeight);
    this.currentPage = clamp(page, 1, Math.max(1, this.pageCount));
    // The window cap can evict a page that is still visible at a low zoom; make
    // sure the page under the focus line comes back.
    void this.renderPage(this.currentPage);
    const locator = this.pdfLocatorNow(tops);
    if (locator.page !== this.lastEmittedPage
      || Math.abs(locator.percent - this.lastEmittedPercent) >= RELOCATION_EPSILON) {
      this.emitRelocated(locator);
    }
  }

  private emitRelocated(locator?: Locator): void {
    if (!this.pdf) {
      return;
    }
    const resolved = locator === undefined ? this.pdfLocatorNow() : locator.kind === 'pdf'
      ? locator
      : pageLocator(this.currentPage, this.pageCount);
    this.lastEmittedPage = resolved.page;
    this.lastEmittedPercent = resolved.percent;
    this.emitter.emit('relocated', { locator: resolved, percent: resolved.percent });
  }

  private scheduleFrame(callback: FrameRequestCallback): number {
    const view = this.container?.ownerDocument?.defaultView;
    if (view?.requestAnimationFrame) {
      return view.requestAnimationFrame(callback);
    }
    return setTimeout(() => callback(Date.now()), 16) as unknown as number;
  }

  private cancelFrame(handle: number): void {
    const view = this.container?.ownerDocument?.defaultView;
    if (view?.cancelAnimationFrame) {
      view.cancelAnimationFrame(handle);
      return;
    }
    clearTimeout(handle);
  }

  private readonly handleScroll = (): void => {
    if (this.mode !== 'continuous' || this.scrollFrame !== null) {
      return;
    }
    this.scrollFrame = this.scheduleFrame(() => {
      this.scrollFrame = null;
      this.updateFromScroll();
    });
  };

  private readonly handleSelectionChange = (): void => {
    if (this.selectionTimer !== null) {
      clearTimeout(this.selectionTimer);
    }
    this.selectionTimer = setTimeout(() => {
      this.selectionTimer = null;
      this.emitSelection();
    }, SELECTION_DEBOUNCE_MS);
  };

  private slotForNode(node: Node): PageSlot | null {
    for (const slot of this.slots.values()) {
      if (slot.inner.contains(node)) {
        return slot;
      }
    }
    return null;
  }

  private emitSelection(): void {
    const doc = this.container?.ownerDocument;
    const container = this.container;
    if (!doc || !container) {
      this.clearSelection();
      return;
    }

    const selection = doc.getSelection();
    if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
      this.clearSelection();
      return;
    }

    const range = selection.getRangeAt(0);
    const text = selection.toString().trim();
    if (text.length === 0 || !container.contains(range.commonAncestorContainer)) {
      this.clearSelection();
      return;
    }

    const slot = this.slotForNode(range.commonAncestorContainer) ?? this.slotForNode(range.startContainer);
    if (!slot) {
      this.clearSelection();
      return;
    }
    // A scanned PDF has no text spans; there is nothing selectable and no crash.
    if (pageTextOf(slot.textLayer).length === 0) {
      this.clearSelection();
      return;
    }

    const pageBox = slot.inner.getBoundingClientRect();
    if (!(pageBox.width > 0) || !(pageBox.height > 0)) {
      this.clearSelection();
      return;
    }

    // Keep only rects that belong to the anchor page: a selection spanning two
    // pages must not paint phantom strips on the wrong page.
    const clientRects = Array.from(range.getClientRects())
      .filter((rect) => rect.width > 0 && rect.height > 0)
      .filter((rect) => rect.right > pageBox.left && rect.left < pageBox.right
        && rect.bottom > pageBox.top && rect.top < pageBox.bottom);
    if (clientRects.length === 0) {
      this.clearSelection();
      return;
    }

    const rects = rectsFromClientRects(clientRects, pageBox)
      .filter((rect) => rect.w > 0 && rect.h > 0)
      .slice(0, MAX_SELECTION_RECTS);
    const union = unionRects(rects);
    if (!union) {
      this.clearSelection();
      return;
    }

    let left = Infinity;
    let top = Infinity;
    let right = -Infinity;
    let bottom = -Infinity;
    for (const rect of clientRects) {
      left = Math.min(left, rect.left);
      top = Math.min(top, rect.top);
      right = Math.max(right, rect.right);
      bottom = Math.max(bottom, rect.bottom);
    }

    const page = slot.pageNumber;
    const locator: PdfLocator = {
      kind: 'pdf',
      page,
      percent: percentForPage(page, Math.max(1, this.pageCount), union.y),
      rect: union,
      rects,
      charOffset: Math.max(0, charOffsetForRange(slot.textLayer, range)),
    };
    const payload: ReaderSelection = {
      text,
      locator,
      rect: { left, top, width: right - left, height: bottom - top },
    };

    this.emitter.emit('selection', payload);
  }

  private clearSelection(): void {
    this.emitter.emit('selection', null);
  }

  private paintHighlightsForSlot(slot: PageSlot): void {
    const layer = slot.highlightLayer;
    layer.replaceChildren();

    for (const highlight of this.highlightsByPage.get(slot.pageNumber) ?? []) {
      const rects = highlight.locator.rects?.length
        ? highlight.locator.rects
        : highlight.locator.rect ? [highlight.locator.rect] : [];

      for (const rect of rects) {
        const marker = document.createElement('div');
        marker.dataset.highlightId = highlight.id;
        marker.style.position = 'absolute';
        marker.style.left = `${rect.x * 100}%`;
        marker.style.top = `${rect.y * 100}%`;
        marker.style.width = `${rect.w * 100}%`;
        marker.style.height = `${rect.h * 100}%`;
        marker.style.background = HIGHLIGHT_HEX[highlight.color];
        marker.style.pointerEvents = 'auto';
        marker.style.cursor = 'pointer';
        marker.style.borderRadius = '2px';
        if (highlight.hasNote) {
          marker.dataset.hasNote = 'true';
        }
        marker.addEventListener('click', (event) => {
          event.stopPropagation();
          this.emitter.emit('highlightClick', { id: highlight.id });
        }, { signal: this.abort.signal });
        layer.append(marker);
      }
    }
  }

  private flash(pageNumber: number, rect?: LocatorRect): void {
    const slot = this.slots.get(pageNumber);
    if (!slot) {
      return;
    }

    let target: HTMLElement = slot.outer;
    const temporary = rect !== undefined;
    if (rect) {
      const marker = document.createElement('div');
      marker.className = 'bookr-flash bookr-flash-rect';
      marker.style.position = 'absolute';
      marker.style.left = `${rect.x * 100}%`;
      marker.style.top = `${rect.y * 100}%`;
      marker.style.width = `${rect.w * 100}%`;
      marker.style.height = `${rect.h * 100}%`;
      marker.style.pointerEvents = 'none';
      slot.highlightLayer.append(marker);
      target = marker;
    } else {
      target.classList.add('bookr-flash');
    }

    const timer = setTimeout(() => {
      target.classList.remove('bookr-flash');
      if (temporary) {
        target.remove();
      }
      this.flashTimers.delete(timer);
    }, FLASH_DURATION_MS);
    this.flashTimers.add(timer);
  }

  private async relayout(redetectCrop: boolean, locator: Locator): Promise<void> {
    const pdf = this.pdf;
    if (!pdf) {
      return;
    }
    const version = this.layoutVersion + 1;
    this.layoutVersion = version;

    try {
      if (redetectCrop) {
        const settings = this.settings;
        this.detectedCrop = settings && settings.pdf.crop === 'auto'
          ? await this.detectCrop(await pdf.getPage(1))
          : zeroCrop();
      }
      if (version !== this.layoutVersion || this.pdf !== pdf || !this.settings) {
        return;
      }
      this.crop = this.effectiveCrop(this.settings);
      this.rebuildLayout();
      await this.goTo(locator);
    } catch (error) {
      this.emitRenderFailure(error);
    }
  }

  private effectiveCrop(settings: ReaderSettings): CropMargins {
    const detected = settings.pdf.crop === 'auto' ? this.detectedCrop : zeroCrop();
    const adjust = settings.pdf.cropAdjust;
    const [top, bottom] = capPair(detected.top + adjust.top / 100, detected.bottom + adjust.bottom / 100);
    const [left, right] = capPair(detected.left + adjust.left / 100, detected.right + adjust.right / 100);
    return { top, right, bottom, left };
  }

  private async detectCrop(page: PDFPageProxy): Promise<CropMargins> {
    try {
      const base = page.getViewport({ scale: 1 });
      if (!(base.width > 0)) {
        return zeroCrop();
      }

      const scale = CROP_PREVIEW_WIDTH / base.width;
      const viewport = page.getViewport({ scale });
      const doc = this.container?.ownerDocument ?? document;
      const canvas = doc.createElement('canvas');
      canvas.width = Math.max(1, Math.round(viewport.width));
      canvas.height = Math.max(1, Math.round(viewport.height));
      const context = canvas.getContext('2d', { willReadFrequently: true });
      if (!context) {
        return zeroCrop();
      }

      await page.render({ canvas, viewport }).promise;
      const pixels = context.getImageData(0, 0, canvas.width, canvas.height).data;
      const margins = detectCropMargins(pixels, canvas.width, canvas.height);
      const capped: CropMargins = {
        top: Math.min(margins.top, AUTO_CROP_LIMIT),
        right: Math.min(margins.right, AUTO_CROP_LIMIT),
        bottom: Math.min(margins.bottom, AUTO_CROP_LIMIT),
        left: Math.min(margins.left, AUTO_CROP_LIMIT),
      };
      const empty = capped.top === 0 && capped.right === 0
        && capped.bottom === 0 && capped.left === 0;
      return empty ? zeroCrop() : capped;
    } catch {
      return zeroCrop();
    }
  }

  private async readTitle(): Promise<string | null> {
    const pdf = this.pdf;
    if (!pdf) {
      return null;
    }
    try {
      const { info } = await pdf.getMetadata();
      const title = (info as Record<string, unknown>).Title;
      return typeof title === 'string' && title.trim().length > 0 ? title : null;
    } catch {
      return null;
    }
  }

  private async readToc(): Promise<TocItem[]> {
    const pdf = this.pdf;
    if (!pdf) {
      return [];
    }
    let outline: readonly PdfOutlineNode[] = [];
    try {
      const raw = await pdf.getOutline();
      outline = (raw ?? []) as readonly PdfOutlineNode[];
    } catch {
      outline = [];
    }
    return buildPdfToc(outline, this.pageCount, (dest) => this.resolveDestination(dest));
  }

  private async resolveDestination(dest: unknown): Promise<number | null> {
    const pdf = this.pdf;
    if (!pdf || dest === null || dest === undefined) {
      return null;
    }
    try {
      let target: unknown = dest;
      if (typeof dest === 'string') {
        target = await pdf.getDestination(dest);
      }
      if (!Array.isArray(target) || target.length === 0) {
        return null;
      }
      const ref: unknown = target[0];
      if (typeof ref === 'number' && Number.isFinite(ref)) {
        return Math.floor(ref) + 1;
      }
      if (typeof ref === 'object' && ref !== null) {
        const index = await pdf.getPageIndex(ref as Parameters<PDFDocumentProxy['getPageIndex']>[0]);
        return Number.isFinite(index) ? index + 1 : null;
      }
    } catch {
      return null;
    }
    return null;
  }
}
