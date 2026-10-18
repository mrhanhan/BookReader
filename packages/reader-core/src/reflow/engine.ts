import type { Locator, LocatorRect, ReflowLocator, ReflowPack } from '@bookr/shared';

import { TypedEmitter } from '../emitter';
import { clamp, percentForPage } from '../locator';
import {
  DEFAULT_CONTEXT_MAX_CHARS,
  capContextText,
  normalizeContextText,
  reflowChapterText,
} from '../text-context';
import type {
  OpenReaderOptions,
  ReaderContextScope,
  ReaderDocumentInfo,
  ReaderEngine,
  ReaderEventMap,
  ReaderHighlight,
  ReaderSettings,
  ReaderTextContext,
  TocItem,
} from '../types';
import { marksForHighlights, renderBlockText, type ReflowMark } from './highlights';
import { reflowLocatorFor } from './mapping';
import { indexForPack, indexReflowPack } from './pack';
import {
  applyReflowStyles,
  renderReflowDocument,
  type RenderedReflowDocument,
} from './render';
import { selectionToReflow, type ReflowRangeRef } from './selection';
import { SourcePagePainter, type SourcePagePainterLike } from './source-painter';

/** Loads and parses a pack; the default fetches JSON over HTTP. */
export type ReflowPackLoader = (url: string) => Promise<unknown>;

/** Builds the original-page painter; the default needs a source PDF URL. */
export type ReflowPainterFactory = (
  options: OpenReaderOptions,
) => SourcePagePainterLike | null;

export interface ReflowEngineDeps {
  fetchPack?: ReflowPackLoader;
  painterFactory?: ReflowPainterFactory;
}

/** One visual placeholder awaiting its original-page crop. */
interface VisualBlockSlot {
  page: number;
  rect: LocatorRect;
  figure: HTMLElement;
  canvas: HTMLCanvasElement;
  painted: boolean;
  noteShown: boolean;
}

/** One block's cached vertical position, in document order. */
interface BlockMetric {
  element: HTMLElement;
  offsetTop: number;
}

/** Fraction of the viewport one `next`/`previous` step covers. */
const SCROLL_STEP_RATIO = 0.9;
/** Viewport height assumed before the host has layout. */
const FALLBACK_CLIENT_HEIGHT = 600;
/** Reading focus sits a third of the way down the viewport. */
const FOCUS_RATIO = 0.33;
/**
 * Sub-pixel slack at the focus line. Browsers may round `scrollTop` when it is
 * assigned, which would otherwise push an anchored block just below the line.
 */
const FOCUS_SLACK = 1;
const FLASH_DURATION_MS = 1200;
/** Minimum percentage movement that warrants a new `relocated` event. */
const RELOCATION_EPSILON = 0.0005;
/** Same debounce as the PDF engine, so the floating menu feels identical. */
const SELECTION_DEBOUNCE_MS = 60;
/** Paint visual blocks two viewports ahead of the reader. */
const VISUAL_OBSERVER_MARGIN = '200% 0px';
/** Shown when a visual block's source page cannot be painted. */
const VISUAL_FALLBACK_NOTE = '原文图像暂不可用，可切回原版查看';

function defaultPainterFactory(options: OpenReaderOptions): SourcePagePainterLike | null {
  return options.sourcePdfUrl ? new SourcePagePainter(options) : null;
}

/** Stable identity of a block's marks, used to skip needless DOM rewrites. */
function marksSignature(marks: ReflowMark[]): string {
  return marks
    .map((mark) => `${mark.id}:${mark.charRange[0]}:${mark.charRange[1]}:${mark.color}:${mark.hasNote ? 1 : 0}`)
    .join('|');
}

async function fetchPackJson(url: string): Promise<unknown> {
  if (typeof globalThis.fetch !== 'function') {
    throw new Error('fetch is not available');
  }
  const response = await globalThis.fetch(url);
  if (!response.ok) {
    throw new Error(`Failed to fetch reflow pack (HTTP ${response.status})`);
  }
  return response.json();
}

function readableError(error: unknown): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return 'Unknown reflow error';
}

function buildToc(pack: ReflowPack): TocItem[] {
  const pageCount = pack.source.pageCount;
  return pack.toc.map((entry, index) => ({
    id: `reflow-toc-${index}`,
    label: entry.label,
    depth: Math.max(0, entry.level - 1),
    locator: {
      kind: 'reflow',
      sourcePage: entry.page,
      percent: percentForPage(entry.page, pageCount),
    },
    children: [],
  }));
}

/**
 * Renders a reflow pack as scrollable prose.
 *
 * The engine owns the `.bookr-reflow-scroll` host: it maps every supported
 * locator into the pack, keeps the current position in sync with the scroll
 * offset, and reports `relocated` events. Typography is applied through CSS
 * custom properties, so settings changes never rebuild the document or reset
 * the reader's place. Text selection is reported as reflow locators,
 * highlights are painted as inline marks, and visual blocks are filled from
 * the original PDF page when `open` receives a `sourcePdfUrl`.
 */
export class ReflowReaderEngine implements ReaderEngine {
  readonly kind = 'reflow' as const;

  private readonly emitter = new TypedEmitter<ReaderEventMap>();
  private readonly fetchPack: ReflowPackLoader;
  private readonly painterFactory: ReflowPainterFactory;
  private readonly flashTimers = new Map<HTMLElement, ReturnType<typeof setTimeout>>();

  private container: HTMLElement | null = null;
  private pack: ReflowPack | null = null;
  private rendered: RenderedReflowDocument | null = null;
  /** Text blocks only; visual blocks carry no text and receive no marks. */
  private textElements: HTMLElement[] = [];
  /** Every block in document order; the anchors for position tracking. */
  private blockElements: HTMLElement[] = [];
  /** Whether a block's rendered marks already match its highlights. */
  private markSignatures = new WeakMap<HTMLElement, string>();
  /** Original block text, captured before marks wrap it. */
  private blockTexts = new WeakMap<HTMLElement, string>();
  /** Text elements per block id, in document order (ids repeat across pages). */
  private textElementsById = new Map<string, HTMLElement[]>();
  /** First block per source page, the anchor for page-only jumps. */
  private firstBlockByPage = new Map<number, HTMLElement>();
  private visualBlocks: VisualBlockSlot[] = [];
  private painter: SourcePagePainterLike | null = null;
  private visualObserver: IntersectionObserver | null = null;
  private selectionTimer: ReturnType<typeof setTimeout> | null = null;
  /** Cached block offsets; the scroll hot path binary-searches this. */
  private blockMetrics: BlockMetric[] = [];
  private settings: ReaderSettings | null = null;
  private highlights: ReaderHighlight[] = [];
  private listenerAbort: AbortController | null = null;
  private resizeObserver: ResizeObserver | null = null;
  private scrollFrame: number | null = null;
  private lastEmittedPercent = -1;
  private lastEmittedBlockId: string | null = null;
  private lastEmittedSourcePage: number | null = null;
  private emitCount = 0;
  /** Incremented by every teardown so stale async work can detect it is gone. */
  private lifecycle = 0;

  constructor(deps: ReflowEngineDeps = {}) {
    this.fetchPack = deps.fetchPack ?? fetchPackJson;
    this.painterFactory = deps.painterFactory ?? defaultPainterFactory;
  }

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
    this.teardown();
    const token = this.lifecycle;
    this.container = container;
    this.settings = settings;

    try {
      const payload = await this.fetchPack(url);
      this.ensureAlive(token);
      const pack = indexReflowPack(payload);
      this.pack = pack;

      const rendered = renderReflowDocument(pack, container);
      this.rendered = rendered;
      applyReflowStyles(rendered.article, settings);
      this.textElements = Array.from(
        rendered.article.querySelectorAll<HTMLElement>(
          '[data-block-type="heading"], [data-block-type="paragraph"]',
        ),
      );
      // Visual blocks anchor position tracking too: a page may contain only
      // figures (scanned pages, fallback pages with OCR disabled).
      this.blockElements = Array.from(
        rendered.article.querySelectorAll<HTMLElement>('[data-block-id]'),
      );
      this.blockTexts = new WeakMap();
      this.markSignatures = new WeakMap();
      this.textElementsById = new Map();
      this.firstBlockByPage = new Map();
      for (const element of this.textElements) {
        this.blockTexts.set(element, element.textContent ?? '');
        // A freshly rendered block is plain text, i.e. it carries no marks.
        this.markSignatures.set(element, '');
        const blockId = element.dataset.blockId;
        if (blockId) {
          const group = this.textElementsById.get(blockId);
          if (group) {
            group.push(element);
          } else {
            this.textElementsById.set(blockId, [element]);
          }
        }
      }
      for (const element of this.blockElements) {
        const sourcePage = Number(element.dataset.sourcePage);
        if (Number.isFinite(sourcePage) && sourcePage >= 1) {
          const page = Math.floor(sourcePage);
          if (!this.firstBlockByPage.has(page)) {
            this.firstBlockByPage.set(page, element);
          }
        }
      }
      this.measureBlocks();
      this.attachListeners(rendered.host, rendered.article);
      this.applyHighlights();
      this.attachVisualBlocks(rendered, options);

      const emittedBefore = this.emitCount;
      if (options.initialLocator) {
        await this.goTo(options.initialLocator);
      } else {
        await this.goToPercent(0);
      }
      // A locator the pack cannot map still owes the caller one initial event.
      if (this.emitCount === emittedBefore) {
        this.emitRelocated();
      }
      this.ensureAlive(token);

      return {
        kind: 'reflow',
        title: null,
        pageCount: pack.source.pageCount,
        toc: buildToc(pack),
      };
    } catch (error) {
      if (token !== this.lifecycle) {
        // destroy()/reopen won the race; the caller asked for teardown.
        throw new Error('The reader was destroyed while opening');
      }
      this.emitter.emit('error', { code: 'load-failed', message: readableError(error) });
      this.teardown();
      throw new Error('Invalid reflow pack');
    }
  }

  async goTo(locator: Locator, options: { flash?: boolean } = {}): Promise<void> {
    const { pack } = this.openState();

    const mapped = reflowLocatorFor(locator, pack);
    if (!mapped) {
      // Unknown locator kinds still carry a book percentage; honour it and
      // never throw so a stale saved position cannot strand the reader.
      const percent = typeof locator === 'object' && locator !== null
        ? (locator as { percent?: unknown }).percent
        : undefined;
      if (typeof percent === 'number' && Number.isFinite(percent)) {
        await this.goToPercent(percent);
      }
      return;
    }

    const element = mapped.blockId
      ? this.findBlockElement(mapped.blockId, mapped.sourcePage)
      : null;
    // A page jump without a block (or a stale block id) anchors the page's
    // first block on the focus line, so `currentLocator` reports exactly the
    // requested source page instead of whatever page the percent hits.
    const target = element ?? this.firstBlockOnPage(mapped.sourcePage);
    if (target) {
      this.scrollElementToFocus(target);
      if (options.flash) {
        this.flash(target);
      }
      this.emitRelocated();
      return;
    }
    await this.goToPercent(mapped.percent);
  }

  async goToPercent(percent: number): Promise<void> {
    const host = this.openState().rendered.host;
    const value = clamp(Number.isFinite(percent) ? percent : 0, 0, 1);
    host.scrollTop = value * this.maxScroll(host);
    this.emitRelocated();
  }

  async next(): Promise<void> {
    this.scrollByViewport(1);
  }

  async previous(): Promise<void> {
    this.scrollByViewport(-1);
  }

  currentLocator(): Locator {
    this.assertOpen();
    return this.locatorNow();
  }

  async getTextContext(
    scope: ReaderContextScope,
    maxChars: number = DEFAULT_CONTEXT_MAX_CHARS,
  ): Promise<ReaderTextContext> {
    const { pack } = this.openState();
    const index = indexForPack(pack);
    const locator = this.locatorNow();
    const limit = maxChars ?? DEFAULT_CONTEXT_MAX_CHARS;

    if (scope === 'chapter') {
      const chapter = reflowChapterText(
        index,
        locator.sourcePage,
        locator.blockId ?? null,
        limit,
      );
      return { scope, text: chapter.text, label: chapter.label, truncated: chapter.truncated };
    }

    const blocks = index.textBlocksOnPage(locator.sourcePage);
    const text = normalizeContextText(blocks.map((block) => block.text ?? '').join('\n\n'));
    const capped = capContextText(text, limit);
    return {
      scope,
      text: capped.text,
      label: `第 ${locator.sourcePage} 页`,
      truncated: capped.truncated,
    };
  }

  setSettings(settings: ReaderSettings): void {
    this.settings = settings;
    const rendered = this.rendered;
    if (!rendered) {
      return;
    }

    // Capture the anchor before the typography changes the layout underneath.
    const anchor = this.locatorNow();
    const anchorElement = anchor.blockId
      ? this.findBlockElement(anchor.blockId, anchor.sourcePage)
      : null;
    const anchorTop = anchorElement?.offsetTop ?? null;
    // Typography lives entirely in custom properties: no DOM rewrite, so the
    // browser keeps the scroll offset the reader is sitting at.
    applyReflowStyles(rendered.article, settings);
    // Applying styles reflows the article; cached offsets are stale now.
    this.measureBlocks();

    if (anchorElement) {
      // A settings object that leaves the layout alone must not move the
      // reader at all; only a real reflow needs re-anchoring.
      if (anchorTop !== null && anchorElement.offsetTop === anchorTop) {
        return;
      }
      this.scrollElementToFocus(anchorElement);
      return;
    }
    // The anchor block is gone (or the page has no blocks): keep the old spot.
    rendered.host.scrollTop = clamp(anchor.percent, 0, 1) * this.maxScroll(rendered.host);
  }

  setHighlights(highlights: ReaderHighlight[]): void {
    this.highlights = Array.isArray(highlights) ? highlights.slice() : [];
    this.applyHighlights();
  }

  /**
   * Rewrites only blocks whose marks changed. Replacing untouched blocks
   * would collapse a live selection on every annotation-cache refresh.
   */
  private applyHighlights(): void {
    if (!this.rendered) {
      return;
    }
    const marksByBlock = marksForHighlights(this.highlights);
    for (const element of this.textElements) {
      const blockId = element.dataset.blockId;
      if (!blockId) {
        continue;
      }
      // Block ids repeat across pages. When this id resolves to a single text
      // element, that element is the authority: a cross-page highlight stores
      // every range under one locator page, so filtering by page would hide
      // the other page's half. Only a duplicated id needs the page filter.
      const sourcePage = Number(element.dataset.sourcePage);
      const candidates = this.textElementsById.get(blockId) ?? [];
      const blockMarks = marksByBlock.get(blockId) ?? [];
      const marks = candidates.length <= 1
        ? blockMarks
        : blockMarks.filter((mark) => mark.sourcePage === sourcePage);
      const signature = marksSignature(marks);
      if (this.markSignatures.get(element) === signature) {
        continue;
      }
      const text = this.blockTexts.get(element) ?? element.textContent ?? '';
      renderBlockText(element, text, marks);
      this.markSignatures.set(element, signature);
    }
  }

  async destroy(): Promise<void> {
    this.teardown();
    this.emitter.clear();
  }

  private ensureAlive(token: number): void {
    if (token !== this.lifecycle) {
      throw new Error('The reader was destroyed while opening');
    }
  }

  /** Navigation and locators are only meaningful after `open` and before `destroy`. */
  private assertOpen(): void {
    if (!this.pack || !this.rendered) {
      throw new Error('Reader is not open');
    }
  }

  private openState(): { pack: ReflowPack; rendered: RenderedReflowDocument } {
    this.assertOpen();
    // assertOpen guarantees both fields; keeps callers free of non-null noise.
    return { pack: this.pack as ReflowPack, rendered: this.rendered as RenderedReflowDocument };
  }

  private attachListeners(host: HTMLElement, article: HTMLElement): void {
    this.listenerAbort?.abort();
    const abort = new AbortController();
    this.listenerAbort = abort;
    host.addEventListener('scroll', this.handleScroll, { passive: true, signal: abort.signal });
    host.addEventListener('click', this.handleClick, { signal: abort.signal });

    const document = this.container?.ownerDocument;
    document?.addEventListener('selectionchange', this.handleSelectionChange, {
      signal: abort.signal,
    });

    const view = document?.defaultView;
    view?.addEventListener('resize', this.handleLayoutChange, {
      passive: true,
      signal: abort.signal,
    });

    if (typeof ResizeObserver !== 'undefined') {
      // The article's height changes when typography or fonts reflow the text;
      // the scroll host keeps a fixed size and would never report that.
      const observer = new ResizeObserver(() => this.measureBlocks());
      observer.observe(article);
      this.resizeObserver = observer;
    }
  }

  /**
   * Starts painting the original-page crops behind visual blocks.
   *
   * Without a source PDF — or with a painter that cannot be built — every
   * figure immediately explains why it is empty. With a source, figures are
   * painted when they come within two viewports of the reader, or right away
   * on hosts without `IntersectionObserver`.
   */
  private attachVisualBlocks(
    rendered: RenderedReflowDocument,
    options: OpenReaderOptions,
  ): void {
    this.visualBlocks = [];
    for (const block of rendered.visualBlocks) {
      const canvas = block.element.querySelector('canvas');
      if (!canvas) {
        continue;
      }
      this.visualBlocks.push({
        page: block.page,
        rect: block.rect,
        figure: block.element,
        canvas,
        painted: false,
        noteShown: false,
      });
    }
    if (this.visualBlocks.length === 0) {
      return;
    }

    let painter: SourcePagePainterLike | null = null;
    try {
      painter = this.painterFactory(options);
    } catch {
      painter = null;
    }
    const sourcePdfUrl = options.sourcePdfUrl;
    if (!painter || !sourcePdfUrl) {
      if (painter) {
        void painter.destroy().catch(() => {});
      }
      for (const slot of this.visualBlocks) {
        this.showVisualNote(slot);
      }
      return;
    }

    this.painter = painter;
    void painter.load(sourcePdfUrl).catch(() => {
      // Each paint reports its own failure; the note only appears per figure.
    });

    if (typeof IntersectionObserver === 'undefined') {
      for (const slot of this.visualBlocks) {
        void this.paintVisual(slot);
      }
      return;
    }

    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) {
          continue;
        }
        const slot = this.visualBlocks.find((candidate) => candidate.figure === entry.target);
        if (slot) {
          void this.paintVisual(slot);
        }
      }
    }, { rootMargin: VISUAL_OBSERVER_MARGIN });
    for (const slot of this.visualBlocks) {
      observer.observe(slot.figure);
    }
    this.visualObserver = observer;
  }

  private async paintVisual(slot: VisualBlockSlot): Promise<void> {
    if (slot.painted) {
      return;
    }
    // Mark before awaiting so overlapping observer callbacks cannot double-paint.
    slot.painted = true;

    const painter = this.painter;
    if (!painter) {
      this.showVisualNote(slot);
      return;
    }

    const token = this.lifecycle;
    try {
      await painter.paint(slot.page, slot.rect, slot.canvas);
    } catch {
      if (token !== this.lifecycle) {
        return;
      }
      slot.canvas.style.display = 'none';
      this.showVisualNote(slot);
    }
  }

  /** Adds the fallback line once; repeated paint failures must not stack it. */
  private showVisualNote(slot: VisualBlockSlot): void {
    if (slot.noteShown) {
      return;
    }
    slot.noteShown = true;
    const note = slot.figure.ownerDocument.createElement('p');
    note.className = 'bookr-reflow-visual-note';
    note.textContent = VISUAL_FALLBACK_NOTE;
    slot.figure.append(note);
  }

  private readonly handleClick = (event: MouseEvent): void => {
    const target = event.target as Element | null;
    if (!target || typeof target.closest !== 'function') {
      return;
    }
    const mark = target.closest('[data-highlight-id]');
    const article = this.rendered?.article;
    if (!mark || !article?.contains(mark)) {
      return;
    }

    const selection = this.container?.ownerDocument?.getSelection();
    if (selection && selection.rangeCount > 0 && !selection.isCollapsed) {
      // A drag that ends inside a highlight is a text selection, not a mark
      // click; opening the annotation editor here would interrupt selecting.
      return;
    }

    const id = mark.getAttribute('data-highlight-id');
    if (!id) {
      return;
    }
    // The host's tap/click handling must not also fire for annotation clicks.
    event.stopPropagation();
    event.preventDefault();
    this.emitter.emit('highlightClick', { id });
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

  private emitSelection(): void {
    const rendered = this.rendered;
    const document = this.container?.ownerDocument;
    if (!rendered || !document) {
      return;
    }

    const selection = document.getSelection();
    const result = selection ? selectionToReflow(selection, rendered.article) : null;
    if (!result || result.refs.length === 0) {
      this.emitter.emit('selection', null);
      return;
    }

    // Each ref knows the page of the element it came from, which is the only
    // reliable answer when the same block id exists on several pages. Older
    // callers that do not fill it fall back to the first matching element.
    const primary = result.refs[0] as ReflowRangeRef;
    let sourcePage = primary.sourcePage;
    if (sourcePage === undefined) {
      const element = this.textElementsById.get(primary.blockId)?.[0] ?? null;
      const rawPage = Number(element?.dataset.sourcePage);
      if (Number.isFinite(rawPage) && rawPage >= 1) {
        sourcePage = Math.floor(rawPage);
      }
    }
    const locator: ReflowLocator = {
      kind: 'reflow',
      sourcePage: sourcePage ?? 1,
      percent: this.percentFromScroll(rendered.host),
      blockId: primary.blockId,
      charRange: [primary.charRange[0], primary.charRange[1]],
    };
    if (result.refs.length > 1) {
      locator.ranges = result.refs.map((ref) => ({
        blockId: ref.blockId,
        charRange: [ref.charRange[0], ref.charRange[1]],
      }));
    }

    this.emitter.emit('selection', {
      text: result.text,
      locator,
      rect: result.rect,
    });
  }

  private teardown(): void {
    this.lifecycle += 1;
    if (this.scrollFrame !== null) {
      this.cancelFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    this.listenerAbort?.abort();
    this.listenerAbort = null;
    this.resizeObserver?.disconnect();
    this.resizeObserver = null;
    this.visualObserver?.disconnect();
    this.visualObserver = null;
    if (this.selectionTimer !== null) {
      clearTimeout(this.selectionTimer);
      this.selectionTimer = null;
    }
    const painter = this.painter;
    this.painter = null;
    if (painter) {
      void painter.destroy().catch(() => {
        // A painter that already gave up has nothing left to release.
      });
    }

    for (const timer of this.flashTimers.values()) {
      clearTimeout(timer);
    }
    this.flashTimers.clear();

    this.container?.replaceChildren();
    this.container = null;
    this.pack = null;
    this.rendered = null;
    this.textElements = [];
    this.blockElements = [];
    this.blockMetrics = [];
    this.textElementsById = new Map();
    this.firstBlockByPage = new Map();
    this.blockTexts = new WeakMap();
    this.markSignatures = new WeakMap();
    this.visualBlocks = [];
    this.settings = null;
    // Highlights are owned by the reader session, not the DOM. They survive
    // teardown so `setHighlights` before `open` is applied once the pack
    // renders (and so reopening the same reader keeps its annotations).
    this.lastEmittedPercent = -1;
    this.lastEmittedBlockId = null;
    this.lastEmittedSourcePage = null;
    this.emitCount = 0;
  }

  /**
   * Snapshots every block's document offset. Called after render and then
   * only when layout can change (settings, resize), so the scroll hot path
   * never touches `offsetTop` and stays O(log n).
   */
  private measureBlocks(): void {
    this.blockMetrics = this.blockElements.map((element) => ({
      element,
      offsetTop: element.offsetTop,
    }));
  }

  private readonly handleLayoutChange = (): void => {
    this.measureBlocks();
  };

  private maxScroll(host: HTMLElement): number {
    return Math.max(0, host.scrollHeight - host.clientHeight);
  }

  /** First block rendered for a source page, or null for an empty page. */
  private firstBlockOnPage(sourcePage: number): HTMLElement | null {
    return this.firstBlockByPage.get(sourcePage) ?? null;
  }

  /**
   * Puts a block on the reading focus line. `currentLocator` uses the same
   * line, so the block (and therefore its source page) is what gets reported.
   */
  private scrollElementToFocus(element: HTMLElement): void {
    const host = this.openState().rendered.host;
    host.scrollTop = Math.max(0, element.offsetTop - host.clientHeight * FOCUS_RATIO);
  }

  private scrollByViewport(direction: 1 | -1): void {
    const host = this.openState().rendered.host;
    const step = SCROLL_STEP_RATIO * (host.clientHeight || FALLBACK_CLIENT_HEIGHT);
    host.scrollTop = clamp(host.scrollTop + direction * step, 0, this.maxScroll(host));
    this.emitRelocated();
  }

  private locatorNow(): ReflowLocator {
    const host = this.rendered?.host ?? null;
    const percent = host ? this.percentFromScroll(host) : 0;
    const element = this.visibleBlockElement(host);
    if (!element) {
      return { kind: 'reflow', sourcePage: 1, percent };
    }

    const sourcePage = Number(element.dataset.sourcePage);
    const locator: ReflowLocator = {
      kind: 'reflow',
      sourcePage: Number.isFinite(sourcePage) && sourcePage >= 1 ? Math.floor(sourcePage) : 1,
      percent,
    };
    if (element.dataset.blockId) {
      locator.blockId = element.dataset.blockId;
    }
    return locator;
  }

  private percentFromScroll(host: HTMLElement): number {
    const max = this.maxScroll(host);
    return max > 0 ? clamp(host.scrollTop / max, 0, 1) : 0;
  }

  /**
   * Last block above the reading focus line, falling back to the first.
   * Offsets are cached in document order, so a binary search finds the block
   * without walking a book that may contain hundreds of thousands of blocks.
   */
  private visibleBlockElement(host: HTMLElement | null): HTMLElement | null {
    const metrics = this.blockMetrics;
    const first = metrics[0];
    if (!first) {
      return null;
    }
    if (!host) {
      return first.element;
    }

    const focusLine = host.scrollTop + host.clientHeight * FOCUS_RATIO + FOCUS_SLACK;
    let low = 0;
    let high = metrics.length - 1;
    let visible = -1;
    while (low <= high) {
      const mid = (low + high) >> 1;
      const metric = metrics[mid];
      if (metric && metric.offsetTop <= focusLine) {
        visible = mid;
        low = mid + 1;
      } else {
        high = mid - 1;
      }
    }
    let index = visible === -1 ? 0 : visible;
    // Tied offsets (an empty paragraph followed by real text, for example)
    // keep the old linear rule: the later block in document order wins.
    while (index + 1 < metrics.length) {
      const current = metrics[index];
      const next = metrics[index + 1];
      if (!current || !next || next.offsetTop !== current.offsetTop) {
        break;
      }
      index += 1;
    }
    return (metrics[index] ?? first).element;
  }

  private findBlockElement(blockId: string, sourcePage: number): HTMLElement | null {
    const direct = this.rendered?.blockElements.get(blockId) ?? null;
    if (!direct) {
      return null;
    }
    // Ids repeat across pages, so a direct hit only wins for the right page.
    if (direct.dataset.sourcePage === String(sourcePage)) {
      return direct;
    }
    const article = this.rendered?.article;
    if (!article) {
      return null;
    }
    for (const element of article.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (element.dataset.blockId === blockId && element.dataset.sourcePage === String(sourcePage)) {
        return element;
      }
    }
    // The id belongs to another page; the caller falls back to the percent.
    return null;
  }

  private flash(element: HTMLElement): void {
    // Re-targeting the same block restarts the animation and its 1.2s window,
    // so a second click is not cut short by the first click's timer.
    const previous = this.flashTimers.get(element);
    if (previous !== undefined) {
      clearTimeout(previous);
    }
    element.classList.remove('bookr-reflow-flash');
    // Force a style flush so the restarted animation actually plays.
    void element.offsetWidth;
    element.classList.add('bookr-reflow-flash');
    const timer = setTimeout(() => {
      this.flashTimers.delete(element);
      element.classList.remove('bookr-reflow-flash');
    }, FLASH_DURATION_MS);
    this.flashTimers.set(element, timer);
  }

  private readonly handleScroll = (): void => {
    if (this.scrollFrame !== null) {
      return;
    }
    this.scrollFrame = this.scheduleFrame(() => {
      this.scrollFrame = null;
      this.updateFromScroll();
    });
  };

  private updateFromScroll(): void {
    if (!this.pack) {
      return;
    }
    const locator = this.locatorNow();
    // Position changes qualify on any axis: page-only moves must not be hidden
    // by a percent that rounds to the previous value.
    if (
      Math.abs(locator.percent - this.lastEmittedPercent) > RELOCATION_EPSILON
      || (locator.blockId ?? null) !== this.lastEmittedBlockId
      || locator.sourcePage !== this.lastEmittedSourcePage
    ) {
      this.emitLocator(locator);
    }
  }

  private emitRelocated(): void {
    if (!this.pack) {
      return;
    }
    this.emitLocator(this.locatorNow());
  }

  private emitLocator(locator: ReflowLocator): void {
    this.lastEmittedPercent = locator.percent;
    this.lastEmittedBlockId = locator.blockId ?? null;
    this.lastEmittedSourcePage = locator.sourcePage;
    this.emitCount += 1;
    this.emitter.emit('relocated', { locator, percent: locator.percent });
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
}
