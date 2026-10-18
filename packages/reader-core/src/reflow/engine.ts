import type { Locator, ReflowLocator, ReflowPack } from '@bookr/shared';

import { TypedEmitter } from '../emitter';
import { clamp, percentForPage } from '../locator';
import type {
  OpenReaderOptions,
  ReaderDocumentInfo,
  ReaderEngine,
  ReaderEventMap,
  ReaderHighlight,
  ReaderSettings,
  TocItem,
} from '../types';
import { reflowLocatorFor } from './mapping';
import { indexReflowPack } from './pack';
import {
  applyReflowStyles,
  renderReflowDocument,
  type RenderedReflowDocument,
} from './render';

/** Loads and parses a pack; the default fetches JSON over HTTP. */
export type ReflowPackLoader = (url: string) => Promise<unknown>;

export interface ReflowEngineDeps {
  fetchPack?: ReflowPackLoader;
}

/** Fraction of the viewport one `next`/`previous` step covers. */
const SCROLL_STEP_RATIO = 0.9;
/** Viewport height assumed before the host has layout. */
const FALLBACK_CLIENT_HEIGHT = 600;
/** Reading focus sits a third of the way down the viewport. */
const FOCUS_RATIO = 0.33;
/** Blocks jump a little below the viewport top so their first line is readable. */
const SCROLL_TOP_OFFSET = 24;
const FLASH_DURATION_MS = 1200;
/** Minimum percentage movement that warrants a new `relocated` event. */
const RELOCATION_EPSILON = 0.0005;

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
 * the reader's place. Visual-block painting and highlights belong to later
 * tasks; this engine only reserves their DOM.
 */
export class ReflowReaderEngine implements ReaderEngine {
  readonly kind = 'reflow' as const;

  private readonly emitter = new TypedEmitter<ReaderEventMap>();
  private readonly fetchPack: ReflowPackLoader;
  private readonly flashTimers = new Set<ReturnType<typeof setTimeout>>();

  private container: HTMLElement | null = null;
  private pack: ReflowPack | null = null;
  private rendered: RenderedReflowDocument | null = null;
  private textElements: HTMLElement[] = [];
  private settings: ReaderSettings | null = null;
  private highlights: ReaderHighlight[] = [];
  private scrollAbort: AbortController | null = null;
  private scrollFrame: number | null = null;
  private lastEmittedPercent = -1;
  private lastEmittedBlockId: string | null = null;
  private emitCount = 0;
  /** Incremented by every teardown so stale async work can detect it is gone. */
  private lifecycle = 0;

  constructor(deps: ReflowEngineDeps = {}) {
    this.fetchPack = deps.fetchPack ?? fetchPackJson;
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
      this.attachScroll(rendered.host);

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
    const pack = this.pack;
    const host = this.rendered?.host;
    if (!pack || !host) {
      return;
    }

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
    if (element) {
      host.scrollTop = Math.max(0, element.offsetTop - SCROLL_TOP_OFFSET);
      if (options.flash) {
        this.flash(element);
      }
      this.emitRelocated();
      return;
    }
    await this.goToPercent(mapped.percent);
  }

  async goToPercent(percent: number): Promise<void> {
    const host = this.rendered?.host;
    if (!host) {
      return;
    }
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
    return this.locatorNow();
  }

  setSettings(settings: ReaderSettings): void {
    this.settings = settings;
    const article = this.rendered?.article;
    if (!article) {
      return;
    }
    // Typography lives entirely in custom properties: no DOM rewrite, so the
    // browser keeps the scroll offset the reader is sitting at.
    applyReflowStyles(article, settings);
  }

  setHighlights(highlights: ReaderHighlight[]): void {
    // Task 5 paints these; this engine only remembers them for later.
    this.highlights = Array.isArray(highlights) ? highlights.slice() : [];
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

  private attachScroll(host: HTMLElement): void {
    this.scrollAbort?.abort();
    const abort = new AbortController();
    this.scrollAbort = abort;
    host.addEventListener('scroll', this.handleScroll, { passive: true, signal: abort.signal });
  }

  private teardown(): void {
    this.lifecycle += 1;
    if (this.scrollFrame !== null) {
      this.cancelFrame(this.scrollFrame);
      this.scrollFrame = null;
    }
    this.scrollAbort?.abort();
    this.scrollAbort = null;

    for (const timer of this.flashTimers) {
      clearTimeout(timer);
    }
    this.flashTimers.clear();

    this.container?.replaceChildren();
    this.container = null;
    this.pack = null;
    this.rendered = null;
    this.textElements = [];
    this.settings = null;
    this.highlights = [];
    this.lastEmittedPercent = -1;
    this.lastEmittedBlockId = null;
    this.emitCount = 0;
  }

  private maxScroll(host: HTMLElement): number {
    return Math.max(0, host.scrollHeight - host.clientHeight);
  }

  private scrollByViewport(direction: 1 | -1): void {
    const host = this.rendered?.host;
    if (!host) {
      return;
    }
    const step = SCROLL_STEP_RATIO * (host.clientHeight || FALLBACK_CLIENT_HEIGHT);
    host.scrollTop = clamp(host.scrollTop + direction * step, 0, this.maxScroll(host));
    this.emitRelocated();
  }

  private locatorNow(): ReflowLocator {
    const host = this.rendered?.host ?? null;
    const percent = host ? this.percentFromScroll(host) : 0;
    const element = this.visibleTextElement(host);
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

  /** Last text block above the reading focus line, falling back to the first. */
  private visibleTextElement(host: HTMLElement | null): HTMLElement | null {
    const first = this.textElements[0] ?? null;
    if (!first || !host) {
      return first;
    }
    const threshold = host.scrollTop + host.clientHeight * FOCUS_RATIO;
    let visible = first;
    for (const element of this.textElements) {
      if (element.offsetTop <= threshold) {
        visible = element;
      }
    }
    return visible;
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
      return direct;
    }
    for (const element of article.querySelectorAll<HTMLElement>('[data-block-id]')) {
      if (element.dataset.blockId === blockId && element.dataset.sourcePage === String(sourcePage)) {
        return element;
      }
    }
    return direct;
  }

  private flash(element: HTMLElement): void {
    element.classList.remove('bookr-reflow-flash');
    // Force a style flush so re-targeting the same block restarts the animation.
    void element.offsetWidth;
    element.classList.add('bookr-reflow-flash');
    const timer = setTimeout(() => {
      this.flashTimers.delete(timer);
      element.classList.remove('bookr-reflow-flash');
    }, FLASH_DURATION_MS);
    this.flashTimers.add(timer);
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
    if (
      Math.abs(locator.percent - this.lastEmittedPercent) > RELOCATION_EPSILON
      || (locator.blockId ?? null) !== this.lastEmittedBlockId
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
