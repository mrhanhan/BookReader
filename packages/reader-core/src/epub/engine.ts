import type { EpubLocator, Locator } from '@bookr/shared';
import ePub from 'epubjs';
import type { Book, Contents, Location as EpubLocation, Rendition } from 'epubjs';

import { TypedEmitter } from '../emitter';
import { clamp } from '../locator';
import { HIGHLIGHT_HEX } from '../settings';
import type {
  OpenReaderOptions,
  ReaderDocumentInfo,
  ReaderEngine,
  ReaderEventMap,
  ReaderHighlight,
  ReaderSettings,
} from '../types';
import {
  EPUB_THEME_NAMES,
  epubFontStack,
  epubOverrides,
  epubThemeCss,
} from './theme';
import { epubLocator, flattenNavigation } from './navigation';

/** CSS class epub.js attaches to every highlight rectangle. */
const HIGHLIGHT_CLASS = 'bookr-epub-hl';
/** Extra class so the UI can style highlights that carry a note. */
const NOTE_CLASS = 'bookr-epub-hl-note';
/** epub.js splits generated locations into chunks of this many characters. */
const LOCATION_CHUNK = 1600;

interface FrameRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

interface Emission {
  cfi: string;
  href?: string;
  percent: number;
}

interface TrackedListener {
  event: string;
  handler: (...args: never[]) => void;
}

interface ContentSelectionListener {
  handler: () => void;
  options: AddEventListenerOptions;
}

function readableError(error: unknown, fallback = 'Unknown EPUB error'): string {
  if (error instanceof Error && error.message) {
    return error.message;
  }
  if (typeof error === 'string' && error.length > 0) {
    return error;
  }
  return fallback;
}

function finite(value: number): number {
  return Number.isFinite(value) ? value : 0;
}

function readTitle(metadata: unknown): string | null {
  const title = (metadata as { title?: unknown } | null)?.title;
  return typeof title === 'string' && title.trim().length > 0 ? title : null;
}

/**
 * Reflowable EPUB engine backed by epub.js.
 *
 * The book's HTML is untrusted input, so scripted content stays disabled for
 * the lifetime of the rendition. Reading positions are CFIs: epub.js reports
 * them on every relocation, and the engine enriches them with a percentage from
 * a generated location map once that map is ready.
 */
export class EpubReaderEngine implements ReaderEngine {
  readonly kind = 'epub' as const;

  private readonly emitter = new TypedEmitter<ReaderEventMap>();
  private readonly contentListeners = new Map<Document, ContentSelectionListener>();

  private book: Book | null = null;
  private rendition: Rendition | null = null;
  private container: HTMLElement | null = null;
  private settings: ReaderSettings | null = null;
  private renditionListeners: TrackedListener[] = [];
  private contentHook: ((contents: Contents) => void) | null = null;
  private renderHook: ((view: unknown) => void) | null = null;

  private lastLocator: EpubLocator | null = null;
  private lastEmission: Emission | null = null;
  private highlights: ReaderHighlight[] = [];
  private appliedCfi = new Set<string>();
  private pendingPercent: number | null = null;
  private selectionActive = false;
  /** Incremented by every teardown so stale async work can detect it is gone. */
  private lifecycle = 0;

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
    const token = this.lifecycle;

    this.container = container;
    this.settings = settings;
    container.dataset.readerTheme = settings.theme;
    container.replaceChildren();

    try {
      const book = ePub(url, { openAs: 'epub' });
      this.book = book;
      await book.ready;
      this.ensureAlive(token);

      const [metadata, toc] = await Promise.all([
        this.readMetadata(book),
        this.readToc(book),
      ]);
      this.ensureAlive(token);

      const rendition = this.createRendition(book, container, settings);
      this.rendition = rendition;
      this.attachRendition(rendition);
      this.applyThemes(rendition, settings);
      // Highlights registered before open (or while loading) are queued on the
      // rendition now; epub.js injects them into each rendered section.
      this.applyHighlights();

      await this.displayInitial(rendition, options.initialLocator);
      this.ensureAlive(token);

      // Location generation is a full-book scan; it must never delay painting.
      void this.generateLocations(token);

      return {
        kind: 'epub',
        title: readTitle(metadata),
        pageCount: null,
        toc,
      };
    } catch (error) {
      if (token !== this.lifecycle) {
        // destroy()/reopen won the race; the caller asked for teardown.
        throw new Error('The reader was destroyed while opening');
      }
      const message = readableError(error);
      this.emitter.emit('error', { code: 'load-failed', message });
      await this.teardown();
      throw new Error(`Failed to open the EPUB: ${message}`);
    }
  }

  async goTo(locator: Locator, _options: { flash?: boolean } = {}): Promise<void> {
    if (!this.rendition) {
      throw new Error('Reader is not open');
    }
    if (locator.kind !== 'epub') {
      throw new Error('The EPUB reader cannot open a non-EPUB locator');
    }

    const rendition = this.rendition;
    try {
      await rendition.display(locator.cfi);
      return;
    } catch {
      // A stale or malformed CFI should not strand the reader; the href that
      // came with the locator is the next best target.
    }

    if (locator.href) {
      try {
        await rendition.display(locator.href);
        return;
      } catch {
        // Fall through to the failure event below.
      }
    }

    this.emitter.emit('error', {
      code: 'render-failed',
      message: `Could not display the requested EPUB location (${locator.cfi})`,
    });
  }

  async goToPercent(percent: number): Promise<void> {
    if (!this.rendition) {
      throw new Error('Reader is not open');
    }
    const value = clamp(Number.isFinite(percent) ? percent : 0, 0, 1);

    const book = this.book;
    if (book && book.locations.length() > 0) {
      try {
        const cfi = book.locations.cfiFromPercentage(value);
        if (typeof cfi === 'string' && cfi.length > 0) {
          await this.goTo(epubLocator(cfi, undefined, value));
          return;
        }
      } catch {
        // Location math can fail on malformed books; remember the percent.
      }
    }

    // No location map yet: jump as soon as `generateLocations` finishes.
    this.pendingPercent = value;
  }

  async next(): Promise<void> {
    const rendition = this.rendition;
    if (!rendition) {
      throw new Error('Reader is not open');
    }
    try {
      await rendition.next();
    } catch (error) {
      this.reportRenderFailure(error);
    }
  }

  async previous(): Promise<void> {
    const rendition = this.rendition;
    if (!rendition) {
      throw new Error('Reader is not open');
    }
    try {
      await rendition.prev();
    } catch (error) {
      this.reportRenderFailure(error);
    }
  }

  currentLocator(): Locator {
    if (!this.lastLocator) {
      throw new Error('Reader is not open');
    }
    return this.lastLocator;
  }

  setSettings(settings: ReaderSettings): void {
    const previous = this.settings;
    this.settings = settings;
    if (this.container) {
      this.container.dataset.readerTheme = settings.theme;
    }

    const rendition = this.rendition;
    if (!previous || !rendition) {
      return;
    }

    const layoutChanged = previous.epub.flow !== settings.epub.flow
      || previous.epub.spread !== settings.epub.spread;
    if (layoutChanged) {
      // Flow/spread are rendition construction options, so the view manager has
      // to be rebuilt around the current CFI.
      this.rebuildRendition(this.lastLocator ? { ...this.lastLocator } : null);
      return;
    }

    this.applyThemes(rendition, settings);
  }

  setHighlights(highlights: ReaderHighlight[]): void {
    this.highlights = Array.isArray(highlights) ? highlights.slice() : [];
    this.applyHighlights();
  }

  async destroy(): Promise<void> {
    await this.teardown();
    this.highlights = [];
    this.emitter.clear();
  }

  private ensureAlive(token: number): void {
    if (token !== this.lifecycle) {
      throw new Error('The reader was destroyed while opening');
    }
  }

  private renditionOptions(settings: ReaderSettings): {
    width: string;
    height: string;
    flow: string;
    spread: string;
    allowScriptedContent: boolean;
  } {
    return {
      width: '100%',
      height: '100%',
      flow: settings.epub.flow,
      spread: settings.epub.spread,
      // EPUB HTML is untrusted; scripts never run inside the iframe.
      allowScriptedContent: false,
    };
  }

  private createRendition(book: Book, container: HTMLElement, settings: ReaderSettings): Rendition {
    return book.renderTo(container, this.renditionOptions(settings));
  }

  private attachRendition(rendition: Rendition): void {
    const onRelocated = (location: EpubLocation): void => {
      this.handleRelocated(location);
    };
    const onSelected = (cfiRange: string, contents: Contents): void => {
      this.handleSelected(cfiRange, contents);
    };

    rendition.on('relocated', onRelocated);
    rendition.on('selected', onSelected);
    this.renditionListeners = [
      { event: 'relocated', handler: onRelocated as unknown as (...args: never[]) => void },
      { event: 'selected', handler: onSelected as unknown as (...args: never[]) => void },
    ];

    const contentHook = (contents: Contents): void => {
      this.registerContents(contents);
    };
    rendition.hooks.content.register(contentHook);
    this.contentHook = contentHook;

    // epub.js attaches annotations on the render hook; ours runs afterwards so
    // note markers can be decorated. (`classList.add` rejects space-separated
    // class strings, so the note class cannot ride on the annotation call.)
    const renderHook = (view: unknown): void => {
      this.decorateNoteHighlights(view);
    };
    rendition.hooks.render.register(renderHook);
    this.renderHook = renderHook;
  }

  private detachRendition(): void {
    const rendition = this.rendition;
    if (rendition) {
      for (const { event, handler } of this.renditionListeners) {
        try {
          rendition.off(event, handler);
        } catch {
          // Teardown stays best-effort.
        }
      }
      if (this.contentHook) {
        try {
          rendition.hooks.content.deregister(this.contentHook);
        } catch {
          // Teardown stays best-effort.
        }
      }
      if (this.renderHook) {
        try {
          rendition.hooks.render.deregister(this.renderHook);
        } catch {
          // Teardown stays best-effort.
        }
      }
      try {
        rendition.destroy();
      } catch {
        // The view manager may already be gone.
      }
    }

    this.renditionListeners = [];
    this.contentHook = null;
    this.renderHook = null;
    this.rendition = null;
    this.removeContentListeners();
    this.container?.replaceChildren();
  }

  private async displayInitial(
    rendition: Rendition,
    initialLocator: OpenReaderOptions['initialLocator'],
  ): Promise<void> {
    if (initialLocator && initialLocator.kind === 'epub') {
      try {
        await rendition.display(initialLocator.cfi);
        return;
      } catch {
        // A stale CFI (different book revision, hand-edited file) must not
        // prevent the book from opening.
      }
      if (initialLocator.href) {
        try {
          await rendition.display(initialLocator.href);
          return;
        } catch {
          // Stale href too; fall back to the first section below.
        }
      }
    }
    await rendition.display();
  }

  private async generateLocations(token: number): Promise<void> {
    const book = this.book;
    if (!book) {
      return;
    }

    try {
      await book.locations.generate(LOCATION_CHUNK);
    } catch {
      // Some books cannot be indexed; percentages stay approximate.
      return;
    }
    if (token !== this.lifecycle || book !== this.book) {
      return;
    }

    // Percentages derived from the location map are exact; re-announce the
    // current position so the footer can drop its approximate value.
    this.emitCurrentLocation(true);

    if (this.pendingPercent !== null) {
      const percent = this.pendingPercent;
      this.pendingPercent = null;
      try {
        await this.goToPercent(percent);
      } catch {
        // The engine was torn down while applying the deferred jump.
      }
    }
  }

  private handleRelocated(location: EpubLocation): void {
    const start = (location as {
      start?: { cfi?: unknown; href?: unknown; percentage?: unknown };
    } | null)?.start;
    const cfi = typeof start?.cfi === 'string' && start.cfi.length > 0 ? start.cfi : null;
    if (!cfi) {
      return;
    }

    const fallback = typeof start?.percentage === 'number' ? start.percentage : 0;
    const percent = this.percentForCfi(cfi, fallback);
    const href = typeof start?.href === 'string' && start.href.length > 0
      ? start.href
      : this.lastLocator?.href;
    const locator = epubLocator(cfi, href, percent);

    this.lastLocator = locator;
    this.emitRelocated(locator, percent);
  }

  private emitCurrentLocation(force: boolean): void {
    const current = this.lastLocator;
    if (!current) {
      return;
    }
    const percent = this.percentForCfi(current.cfi, current.percent);
    const locator = epubLocator(current.cfi, current.href, percent);
    this.lastLocator = locator;
    this.emitRelocated(locator, percent, force);
  }

  /**
   * Coalesces identical consecutive relocations. Rebuilding the rendition for
   * a flow/spread change re-displays the same CFI, which must not look like the
   * reader moved.
   */
  private emitRelocated(locator: EpubLocator, percent: number, force = false): void {
    if (!force && this.lastEmission
      && this.lastEmission.cfi === locator.cfi
      && this.lastEmission.href === locator.href
      && Math.abs(this.lastEmission.percent - percent) < 1e-6) {
      return;
    }

    this.lastEmission = { cfi: locator.cfi, href: locator.href, percent };
    this.emitter.emit('relocated', { locator, percent });
  }

  private percentForCfi(cfi: string, fallback: number): number {
    const book = this.book;
    if (book) {
      try {
        if (book.locations.length() > 0) {
          const exact = book.locations.percentageFromCfi(cfi);
          if (typeof exact === 'number' && Number.isFinite(exact)) {
            return clamp(exact, 0, 1);
          }
        }
      } catch {
        // Stale CFIs make the location math throw; use epub.js' estimate.
      }
    }
    return clamp(Number.isFinite(fallback) ? fallback : 0, 0, 1);
  }

  private applyThemes(rendition: Rendition, settings: ReaderSettings): void {
    const themes = rendition.themes;
    for (const name of EPUB_THEME_NAMES) {
      themes.registerCss(name, epubThemeCss(name));
    }
    themes.select(settings.theme);
    for (const [property, value] of epubOverrides(settings)) {
      themes.override(property, value);
    }
    themes.font(epubFontStack(settings.epub.fontFamily));
    this.stripInactiveThemeStyles(rendition, settings.theme);
  }

  /**
   * epub.js keeps every selected theme's stylesheet in the iframe, so switching
   * back to an earlier theme would otherwise lose to the newer `body` rule.
   * The active theme is selected first; drop the other theme stylesheets.
   */
  private stripInactiveThemeStyles(rendition: Rendition, active: string): void {
    for (const contents of this.renditionContents(rendition)) {
      try {
        const doc = contents.document;
        if (!doc) {
          continue;
        }
        for (const name of EPUB_THEME_NAMES) {
          if (name === active) {
            continue;
          }
          doc.getElementById(`epubjs-inserted-css-${name}`)?.remove();
        }
      } catch {
        // A detached iframe is harmless.
      }
    }
  }

  private renditionContents(rendition: Rendition): Contents[] {
    try {
      const contents = rendition.getContents() as unknown;
      return Array.isArray(contents) ? (contents as Contents[]) : [];
    } catch {
      return [];
    }
  }

  private applyHighlights(): void {
    const rendition = this.rendition;
    if (!rendition) {
      return;
    }

    // Removal first makes repeated calls with the same list idempotent.
    for (const cfi of this.appliedCfi) {
      try {
        rendition.annotations.remove(cfi, 'highlight');
      } catch {
        // The annotation may already be detached.
      }
    }
    this.appliedCfi.clear();

    for (const highlight of this.highlights) {
      const locator = highlight.locator;
      if (!locator || locator.kind !== 'epub') {
        continue;
      }
      const cfi = locator.cfi;
      const id = highlight.id;
      try {
        rendition.annotations.highlight(
          cfi,
          { id },
          () => this.emitter.emit('highlightClick', { id }),
          HIGHLIGHT_CLASS,
          { fill: HIGHLIGHT_HEX[highlight.color], 'fill-opacity': '0.35' },
        );
        this.appliedCfi.add(cfi);
      } catch {
        // Invalid/stale CFIs must not take the reader down.
      }
    }

    // Marks added to views that are already rendered need the note class now;
    // later renders are handled by the decoration hook.
    for (const contents of this.renditionContents(rendition)) {
      this.decorateDocument(contents.document);
    }
  }

  private decorateNoteHighlights(view: unknown): void {
    const doc = (view as { contents?: { document?: Document } } | null)?.contents?.document;
    if (doc) {
      this.decorateDocument(doc);
    }
  }

  /** Adds/removes the note class on every highlight mark in one document. */
  private decorateDocument(doc: Document | null | undefined): void {
    if (!doc) {
      return;
    }
    try {
      const marks = doc.querySelectorAll(`.${HIGHLIGHT_CLASS}`);
      marks.forEach((mark) => {
        const id = mark.getAttribute('data-id') ?? '';
        const hasNote = this.highlights.some(
          (highlight) => highlight.id === id && highlight.hasNote,
        );
        if (hasNote) {
          mark.classList.add(NOTE_CLASS);
        } else {
          mark.classList.remove(NOTE_CLASS);
        }
      });
    } catch {
      // A detached iframe or an exotic mark implementation is harmless.
    }
  }

  private handleSelected(cfiRange: unknown, contents: unknown): void {
    try {
      const frame = contents as Contents | null;
      const win = frame?.window;
      if (typeof cfiRange !== 'string' || cfiRange.length === 0 || !win
        || typeof win.getSelection !== 'function') {
        this.emitSelectionCleared();
        return;
      }

      const selection = win.getSelection();
      const text = selection ? String(selection.toString()).trim() : '';
      if (!selection || selection.rangeCount === 0 || !text) {
        this.emitSelectionCleared();
        return;
      }

      const range = selection.getRangeAt(0);
      const rangeRect = range.getBoundingClientRect();
      const frameRect = this.frameRect(frame);
      const current = this.lastLocator;
      const locator = epubLocator(cfiRange, current?.href, current?.percent ?? 0);

      this.selectionActive = true;
      this.emitter.emit('selection', {
        text,
        locator,
        rect: {
          left: finite(frameRect.left) + finite(rangeRect.left),
          top: finite(frameRect.top) + finite(rangeRect.top),
          width: Math.max(0, finite(rangeRect.width)),
          height: Math.max(0, finite(rangeRect.height)),
        },
      });
    } catch {
      // Cross-origin or empty selections are routine; never surface them.
      this.emitSelectionCleared();
    }
  }

  private frameRect(contents: Contents): FrameRect {
    try {
      const frame = contents.document?.defaultView?.frameElement;
      if (frame && typeof frame.getBoundingClientRect === 'function') {
        return frame.getBoundingClientRect();
      }
    } catch {
      // Fall through to the container rect.
    }
    if (this.container) {
      return this.container.getBoundingClientRect();
    }
    return { left: 0, top: 0, width: 0, height: 0 };
  }

  private emitSelectionCleared(): void {
    if (!this.selectionActive) {
      return;
    }
    this.selectionActive = false;
    this.emitter.emit('selection', null);
  }

  private registerContents(contents: Contents): void {
    try {
      const doc = contents?.document;
      const win = contents?.window;
      if (!doc || !win) {
        return;
      }
      if (this.contentListeners.has(doc)) {
        return;
      }

      const options: AddEventListenerOptions = { passive: true };
      const handler = (): void => {
        try {
          const selection = win.getSelection();
          if (!selection || selection.isCollapsed || selection.rangeCount === 0) {
            this.emitSelectionCleared();
          }
        } catch {
          this.emitSelectionCleared();
        }
      };
      doc.addEventListener('selectionchange', handler, options);
      this.contentListeners.set(doc, { handler, options });
    } catch {
      // A partially constructed contents object has no document yet.
    }
  }

  private removeContentListeners(): void {
    for (const [doc, listener] of this.contentListeners) {
      try {
        doc.removeEventListener('selectionchange', listener.handler, listener.options);
      } catch {
        // The iframe document may already be detached.
      }
    }
    this.contentListeners.clear();
  }

  private rebuildRendition(saved: EpubLocator | null): void {
    const book = this.book;
    const container = this.container;
    const settings = this.settings;
    if (!book || !container || !settings) {
      return;
    }

    this.detachRendition();
    const rendition = this.createRendition(book, container, settings);
    this.rendition = rendition;
    this.attachRendition(rendition);
    this.applyThemes(rendition, settings);

    this.appliedCfi.clear();
    this.applyHighlights();
    this.selectionActive = false;

    if (saved) {
      void this.goTo(saved);
      return;
    }
    void rendition.display().catch((error: unknown) => this.reportRenderFailure(error));
  }

  private reportRenderFailure(error?: unknown): void {
    this.emitter.emit('error', {
      code: 'render-failed',
      message: readableError(error, 'Could not render the EPUB section'),
    });
  }

  private async readMetadata(book: Book): Promise<unknown> {
    try {
      return await book.loaded.metadata;
    } catch {
      return null;
    }
  }

  private async readToc(book: Book): Promise<ReaderDocumentInfo['toc']> {
    try {
      const navigation = await book.loaded.navigation;
      const items = Array.isArray(navigation?.toc) ? navigation.toc : [];
      return flattenNavigation(items, (href) => book.canonical(href));
    } catch {
      return [];
    }
  }

  private async teardown(): Promise<void> {
    this.lifecycle += 1;

    const book = this.book;
    this.detachRendition();

    if (book) {
      try {
        book.destroy();
      } catch {
        // epub.js teardown is not guaranteed to be safe twice.
      }
    }

    this.book = null;
    this.container?.replaceChildren();
    this.container = null;
    this.settings = null;
    this.lastLocator = null;
    this.lastEmission = null;
    this.pendingPercent = null;
    this.selectionActive = false;
    this.appliedCfi.clear();
  }
}
