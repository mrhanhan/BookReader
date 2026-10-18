import type { Locator, ReflowBlock, ReflowLocator, ReflowPack } from '@bookr/shared';
import { describe, expect, it, vi } from 'vitest';
import { ReflowReaderEngine } from '../reflow/engine';
import { pdfLocatorFor } from '../reflow/mapping';
import { renderReflowDocument } from '../reflow/render';
import { DEFAULT_READER_SETTINGS } from '../settings';
import type { ReaderHighlight, ReaderSelection } from '../types';

function heading(id: string, level: number, y: number): ReflowBlock {
  return {
    id,
    type: 'heading',
    level,
    text: `第 ${id} 节`,
    rect: { x: 0.1, y, w: 0.8, h: 0.05 },
  };
}

function paragraph(id: string, y: number): ReflowBlock {
  return {
    id,
    type: 'paragraph',
    text: `${id} 的正文`,
    rect: { x: 0.1, y, w: 0.8, h: 0.08 },
  };
}

/** Three pages: page 1 and page 3 carry prose, page 2 is an empty image page. */
function makePack(): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'a'.repeat(64), pageCount: 3 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: 3,
      textBlocks: 6,
      fallbackPages: [],
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [
      { label: '第一章', page: 1, level: 1 },
      { label: '第一节', page: 1, level: 2 },
      { label: '第二章', page: 3, level: 1 },
    ],
    pages: [
      {
        page: 1,
        width: 600,
        height: 800,
        blocks: [heading('p1-b0', 1, 0.1), paragraph('p1-b1', 0.55), paragraph('p1-b2', 0.8)],
      },
      { page: 2, width: 600, height: 800, blocks: [] },
      {
        page: 3,
        width: 600,
        height: 800,
        blocks: [heading('p3-b0', 2, 0.1), paragraph('p3-b1', 0.55), paragraph('p3-b2', 0.8)],
      },
    ],
  };
}

/** One short paragraph per page; used for long-book page jumps. */
function makeLongPack(pageCount = 300): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'b'.repeat(64), pageCount },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: pageCount,
      textBlocks: pageCount,
      fallbackPages: [],
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      blocks: [
        {
          id: `p${index + 1}-b0`,
          type: 'paragraph',
          text: `第 ${index + 1} 页的正文`,
          rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.8 },
        },
      ],
    })),
  };
}

function fallbackBlock(id: string): ReflowBlock {
  return { id, type: 'fallback', rect: { x: 0, y: 0, w: 1, h: 1 } };
}

/** Two pages with one distinct text block each. */
function makeTwoPagePack(): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'c'.repeat(64), pageCount: 2 },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: 2,
      textBlocks: 2,
      fallbackPages: [],
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [],
    pages: [
      { page: 1, width: 600, height: 800, blocks: [paragraph('p1-b0', 0.1)] },
      { page: 2, width: 600, height: 800, blocks: [paragraph('p2-b0', 0.1)] },
    ],
  };
}

/** Every page holds a single full-page fallback block and no text at all. */
function makeVisualOnlyPack(pageCount: number): ReflowPack {
  return {
    schemaVersion: 1,
    source: { sha256: 'd'.repeat(64), pageCount },
    generatedAt: '2026-10-18T08:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: '1.0.0' },
    quality: {
      pages: pageCount,
      textBlocks: 0,
      fallbackPages: Array.from({ length: pageCount }, (_, index) => index + 1),
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [],
    pages: Array.from({ length: pageCount }, (_, index) => ({
      page: index + 1,
      width: 600,
      height: 800,
      blocks: [fallbackBlock(`p${index + 1}-visual`)],
    })),
  };
}

function scrollMetrics(host: HTMLElement, scrollHeight = 1500, clientHeight = 500): void {
  let top = 0;
  Object.defineProperty(host, 'scrollHeight', { configurable: true, get: () => scrollHeight });
  Object.defineProperty(host, 'clientHeight', { configurable: true, get: () => clientHeight });
  Object.defineProperty(host, 'scrollTop', {
    configurable: true,
    get: () => top,
    set: (value: number) => {
      top = value;
    },
  });
}

/** jsdom has no layout; stack text-block offsets so the focus rule is observable. */
function stackTextBlocks(container: HTMLElement, step = 200): void {
  let offset = 0;
  for (const element of container.querySelectorAll<HTMLElement>(
    '[data-block-type="heading"], [data-block-type="paragraph"]',
  )) {
    // Capture per element: a shared getter would report the final offset for all.
    const top = offset;
    Object.defineProperty(element, 'offsetTop', { configurable: true, get: () => top });
    offset += step;
  }
}

/** jsdom has no layout; stack every block offset so visual blocks count too. */
function stackBlocks(container: HTMLElement, step = 200): void {
  let offset = 0;
  for (const element of container.querySelectorAll<HTMLElement>('[data-block-id]')) {
    const top = offset;
    Object.defineProperty(element, 'offsetTop', { configurable: true, get: () => top });
    offset += step;
  }
}

/** The engine caches offsets; a resize is the public signal that layout moved. */
function refreshLayout(host: HTMLElement): void {
  host.ownerDocument.defaultView?.dispatchEvent(new Event('resize'));
}

/**
 * Offsets that grow with the article's font size, so a settings change behaves
 * like a real reflow instead of leaving the layout untouched.
 */
function scaleOffsetsWithFontSize(container: HTMLElement, step = 200): void {
  const article = container.querySelector('.bookr-reflow') as HTMLElement;
  let offset = 0;
  for (const element of container.querySelectorAll<HTMLElement>(
    '[data-block-type="heading"], [data-block-type="paragraph"]',
  )) {
    const base = offset;
    offset += step;
    Object.defineProperty(element, 'offsetTop', {
      configurable: true,
      get: () => {
        const size = Number.parseFloat(article.style.getPropertyValue('--reflow-font-size'));
        return (base * (Number.isFinite(size) && size > 0 ? size : 19)) / 19;
      },
    });
  }
}

function blockElement(container: HTMLElement, blockId: string, page: number): HTMLElement {
  const element = Array.from(container.querySelectorAll<HTMLElement>('[data-block-id]')).find(
    (candidate) =>
      candidate.dataset.blockId === blockId && candidate.dataset.sourcePage === String(page),
  );
  if (!element) {
    throw new Error(`missing block ${blockId} on page ${page}`);
  }
  return element;
}

/**
 * Patches jsdom's layout-free `offsetTop` for one test. Block ids encode page
 * and position, so a deterministic stacked layout can answer before the engine
 * measures during `open`.
 */
function withBlockLayout(offsetFor: (blockId: string) => number): () => void {
  const descriptor = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetTop');
  Object.defineProperty(HTMLElement.prototype, 'offsetTop', {
    configurable: true,
    get(this: HTMLElement) {
      return offsetFor(this.dataset.blockId ?? '');
    },
  });
  return () => {
    if (descriptor) {
      Object.defineProperty(HTMLElement.prototype, 'offsetTop', descriptor);
    } else {
      delete (HTMLElement.prototype as { offsetTop?: number }).offsetTop;
    }
  };
}

function stackedOffset(blockId: string): number {
  const match = /^p(\d+)-b(\d+)$/.exec(blockId);
  if (!match) {
    return 0;
  }
  return ((Number(match[1]) - 1) * 3 + Number(match[2])) * 200;
}

/**
 * jsdom's animation frames are not tied to the fake clock; routing frames
 * through setTimeout lets every test advance exactly one throttled frame.
 */
function useTimerFrames(): () => void {
  const view = window;
  const original = view.requestAnimationFrame;
  view.requestAnimationFrame = ((callback: FrameRequestCallback) =>
    setTimeout(() => callback(Date.now()), 16) as unknown as number) as typeof original;
  return () => {
    view.requestAnimationFrame = original;
  };
}

function dispatchScroll(host: HTMLElement): void {
  host.dispatchEvent(new Event('scroll'));
}

function advanceFrame(): void {
  vi.advanceTimersByTime(20);
}

async function openWith(pack: ReflowPack): Promise<{
  engine: ReflowReaderEngine;
  container: HTMLElement;
  host: HTMLElement;
}> {
  const container = document.createElement('div');
  // Selections must be rooted in the document tree for jsdom to accept them.
  document.body.append(container);
  const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
  await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);
  const host = container.querySelector('.bookr-reflow-scroll') as HTMLElement;
  return { engine, container, host };
}

describe('reflow document rendering', () => {
  it('renders text blocks as prose and visual blocks as canvases', () => {
    const pack = makePack();
    pack.pages[0]!.blocks.push({
      id: 'p1-img',
      type: 'image',
      rect: { x: 0.1, y: 0.05, w: 0.8, h: 0.1 },
    });
    const container = document.createElement('div');

    const rendered = renderReflowDocument(pack, container);

    expect(container.children).toHaveLength(1);
    expect(rendered.host.className).toBe('bookr-reflow-scroll');
    expect(rendered.host.contains(rendered.article)).toBe(true);
    expect(rendered.article.className).toBe('bookr-reflow');
    expect(rendered.skippedBlocks).toBe(0);
    expect(rendered.blockElements.size).toBe(7);
    expect(rendered.blockElements.get('p1-b0')).toBeInstanceOf(HTMLHeadingElement);
    expect(rendered.blockElements.get('p1-b1')).toBeInstanceOf(HTMLParagraphElement);
    expect(rendered.blockElements.get('p3-b0')?.tagName).toBe('H2');
    const figure = rendered.blockElements.get('p1-img');
    expect(figure?.tagName).toBe('FIGURE');
    expect(figure?.classList.contains('bookr-reflow-visual')).toBe(true);
    expect(figure?.getAttribute('aria-label')).toBe('原文图像');
    expect(figure?.querySelector('canvas')).not.toBeNull();
    expect(figure?.dataset.sourcePage).toBe('1');
  });

  it('skips unusable blocks instead of throwing', () => {
    const pack = makePack();
    const broken = pack.pages[0]!.blocks[1] as unknown as { rect: unknown };
    broken.rect = null;
    const container = document.createElement('div');

    const rendered = renderReflowDocument(pack, container);

    expect(rendered.skippedBlocks).toBe(1);
    expect(rendered.blockElements.has('p1-b1')).toBe(false);
    expect(rendered.blockElements.size).toBe(5);
  });
});

describe('reflow engine', () => {
  it('renders blocks as text, never as markup', async () => {
    const pack = makePack();
    pack.pages[0]!.blocks[0]!.text = '<script>alert(1)</script>';
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({ fetchPack: async () => pack });

    const info = await engine.open(
      'https://fake-s3.local/pack.json',
      container,
      DEFAULT_READER_SETTINGS,
    );

    expect(info).toMatchObject({ kind: 'reflow', title: null, pageCount: 3 });
    expect(container.querySelector('script')).toBeNull();
    expect(container.querySelector('[data-block-id="p1-b0"]')?.textContent).toBe(
      '<script>alert(1)</script>',
    );
    await engine.destroy();
  });

  it('maps the pack TOC into reflow locators', async () => {
    const pack = makePack();
    const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
    const info = await engine.open(
      'https://fake-s3.local/pack.json',
      document.createElement('div'),
      DEFAULT_READER_SETTINGS,
    );

    expect(info.toc).toEqual([
      {
        id: 'reflow-toc-0',
        label: '第一章',
        depth: 0,
        locator: { kind: 'reflow', sourcePage: 1, percent: 0 },
        children: [],
      },
      {
        id: 'reflow-toc-1',
        label: '第一节',
        depth: 1,
        locator: { kind: 'reflow', sourcePage: 1, percent: 0 },
        children: [],
      },
      {
        id: 'reflow-toc-2',
        label: '第二章',
        depth: 0,
        locator: { kind: 'reflow', sourcePage: 3, percent: 2 / 3 },
        children: [],
      },
    ]);
    await engine.destroy();
  });

  it('opens at a mapped PDF locator and reports relocation', async () => {
    const pack = makePack();
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
    await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);
    const host = container.querySelector('.bookr-reflow-scroll') as HTMLElement;
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);
    const events: Array<{ blockId?: string }> = [];
    engine.on('relocated', ({ locator }) => events.push(locator as { blockId?: string }));

    await engine.goTo({ kind: 'pdf', page: 1, percent: 0.2, rect: { x: 0.1, y: 0.6, w: 0.8, h: 0.02 } });

    // Focus-line anchoring: p1-b1 sits at 200, the focus line is 165px down.
    expect(host.scrollTop).toBe(35);
    expect(events.at(-1)?.blockId).toBe('p1-b1');
    expect(engine.currentLocator()).toMatchObject({ kind: 'reflow', sourcePage: 1, blockId: 'p1-b1' });
    await engine.destroy();
  });

  it('anchors a sourcePage-only reflow locator on the requested page', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 3, percent: 2 / 3 });

    // Page 3's first text block starts at 600; landing on the percent alone
    // would leave the focus line inside page 1.
    expect(host.scrollTop).toBe(600 - 165);
    expect(engine.currentLocator()).toMatchObject({
      kind: 'reflow',
      sourcePage: 3,
      blockId: 'p3-b0',
    });
    await engine.destroy();
  });

  it('anchors a page whose only block is visual and tracks the page after it', async () => {
    const pack = makePack();
    // A scanned page: one fallback block covering the whole source page.
    pack.pages[1]!.blocks = [fallbackBlock('p2-visual')];
    pack.quality.fallbackPages = [2];
    const { engine, container, host } = await openWith(pack);
    scrollMetrics(host);
    stackBlocks(container);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 2, percent: 1 / 3 });

    // Page 1 holds three blocks, so the fallback sits at 600 and is anchored
    // on the focus line; a percent-only jump would land inside page 1.
    expect(host.scrollTop).toBe(600 - 165);
    expect(engine.currentLocator()).toMatchObject({ kind: 'reflow', sourcePage: 2 });

    // Page 3's first block starts at 800; scrolling there must report page 3.
    host.scrollTop = 800 - 165;
    expect(engine.currentLocator()).toMatchObject({ kind: 'reflow', sourcePage: 3 });
    await engine.destroy();
  });

  it('reports the last page of a book made only of visual blocks', async () => {
    const pack = makeVisualOnlyPack(7);
    const { engine, container, host } = await openWith(pack);
    scrollMetrics(host);
    stackBlocks(container);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 7, percent: 6 / 7 });

    const locator = engine.currentLocator();
    expect(locator).toMatchObject({ kind: 'reflow', sourcePage: 7, blockId: 'p7-visual' });
    expect(pdfLocatorFor(locator, pack)).toMatchObject({ kind: 'pdf', page: 7 });
    await engine.destroy();
  });

  it('reports the block page after a block-targeted jump', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 1, percent: 0.9, blockId: 'p1-b2' });

    expect(host.scrollTop).toBe(400 - 165);
    expect(engine.currentLocator()).toMatchObject({ sourcePage: 1, blockId: 'p1-b2' });
    await engine.destroy();
  });

  it('anchors a stale block id to the first text block of its page', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 3, percent: 0.1, blockId: 'missing' });

    expect(host.scrollTop).toBe(600 - 165);
    expect(engine.currentLocator()).toMatchObject({ sourcePage: 3, blockId: 'p3-b0' });
    await engine.destroy();
  });

  it('jumps to source page 120 of a 300-page pack and reports 120', async () => {
    const { engine, container, host } = await openWith(makeLongPack(300));
    scrollMetrics(host, 300 * 200 + 500, 500);
    stackTextBlocks(container, 200);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 120, percent: 119 / 300 });

    expect(host.scrollTop).toBe(119 * 200 - 165);
    expect(engine.currentLocator()).toMatchObject({ sourcePage: 120, blockId: 'p120-b0' });
    await engine.destroy();
  });

  it('opens at the initial locator and emits one relocation', async () => {
    const restoreLayout = withBlockLayout(stackedOffset);
    const engine = new ReflowReaderEngine({ fetchPack: async () => makePack() });
    const container = document.createElement('div');
    const events: Locator[] = [];
    engine.on('relocated', ({ locator }) => events.push(locator));

    try {
      await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS, {
        initialLocator: {
          kind: 'pdf',
          page: 1,
          percent: 0.2,
          rect: { x: 0.1, y: 0.6, w: 0.8, h: 0.02 },
        },
      });

      const host = container.querySelector('.bookr-reflow-scroll') as HTMLElement;
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ kind: 'reflow' });
      // During open the host has no viewport height, so there is no focus-line
      // offset yet: the mapped block starts the scroll at its own top.
      expect(host.scrollTop).toBe(200);
    } finally {
      await engine.destroy();
      restoreLayout();
    }
  });

  it('navigates by page percent and rejects an invalid pack', async () => {
    const pack = makePack();
    const engine = new ReflowReaderEngine({ fetchPack: async () => pack });
    const container = document.createElement('div');
    await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);
    const host = container.querySelector('.bookr-reflow-scroll') as HTMLElement;
    scrollMetrics(host);
    await engine.goToPercent(0.5);
    expect(host.scrollTop).toBe(500);
    await engine.next();
    expect(host.scrollTop).toBe(950);
    await engine.previous();
    expect(host.scrollTop).toBe(500);
    await engine.destroy();

    const errors: string[] = [];
    const bad = new ReflowReaderEngine({ fetchPack: async () => ({ schemaVersion: 99 }) });
    bad.on('error', ({ code }) => errors.push(code));
    await expect(
      bad.open('https://fake-s3.local/bad.json', document.createElement('div'), DEFAULT_READER_SETTINGS),
    ).rejects.toThrow('Invalid reflow pack');
    expect(errors).toEqual(['load-failed']);
  });

  it('rejects a fetch failure as an invalid pack', async () => {
    const errors: string[] = [];
    const engine = new ReflowReaderEngine({
      fetchPack: async () => {
        throw new Error('network down');
      },
    });
    engine.on('error', ({ code }) => errors.push(code));

    await expect(
      engine.open('https://fake-s3.local/pack.json', document.createElement('div'), DEFAULT_READER_SETTINGS),
    ).rejects.toThrow('Invalid reflow pack');
    expect(errors).toEqual(['load-failed']);
  });

  it('rejects navigation and locators when it is not open', async () => {
    const engine = new ReflowReaderEngine({ fetchPack: async () => makePack() });
    const locator: Locator = { kind: 'pdf', page: 1, percent: 0 };

    expect(() => engine.currentLocator()).toThrow('Reader is not open');
    await expect(engine.goTo(locator)).rejects.toThrow('Reader is not open');
    await expect(engine.goToPercent(0.5)).rejects.toThrow('Reader is not open');
    await expect(engine.next()).rejects.toThrow('Reader is not open');
    await expect(engine.previous()).rejects.toThrow('Reader is not open');

    await engine.open(
      'https://fake-s3.local/pack.json',
      document.createElement('div'),
      DEFAULT_READER_SETTINGS,
    );
    await engine.destroy();

    expect(() => engine.currentLocator()).toThrow('Reader is not open');
    await expect(engine.goTo(locator)).rejects.toThrow('Reader is not open');
    await expect(engine.goToPercent(0.5)).rejects.toThrow('Reader is not open');
    await expect(engine.next()).rejects.toThrow('Reader is not open');
    await expect(engine.previous()).rejects.toThrow('Reader is not open');
  });

  it('falls back to the percent when a block id lives on another page', async () => {
    const { engine, host } = await openWith(makePack());
    scrollMetrics(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 2, percent: 0.5, blockId: 'p1-b0' });

    expect(host.scrollTop).toBe(500);
    await engine.destroy();
  });

  it('throttles scroll relocation and ignores tiny movements', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);
    const percents: number[] = [];
    engine.on('relocated', ({ percent }) => percents.push(percent));

    vi.useFakeTimers();
    const restoreFrames = useTimerFrames();
    try {
      host.scrollTop = 600;
      dispatchScroll(host);
      // Still throttled: no relocation until the animation frame runs.
      expect(percents).toEqual([]);

      advanceFrame();
      expect(percents).toHaveLength(1);
      expect(percents[0]).toBeCloseTo(0.6, 5);

      percents.length = 0;
      host.scrollTop = 600.2;
      dispatchScroll(host);
      advanceFrame();
      expect(percents).toEqual([]);
    } finally {
      restoreFrames();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('emits when the visible block changes although the percent does not', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);
    const events: Locator[] = [];
    engine.on('relocated', ({ locator }) => events.push(locator));

    vi.useFakeTimers();
    const restoreFrames = useTimerFrames();
    try {
      host.scrollTop = 200;
      dispatchScroll(host);
      advanceFrame();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sourcePage: 1, blockId: 'p1-b1', percent: 0.2 });

      // The next block slides above the focus line without moving the scroll.
      Object.defineProperty(blockElement(container, 'p1-b2', 1), 'offsetTop', {
        configurable: true,
        get: () => 300,
      });
      refreshLayout(host);

      dispatchScroll(host);
      advanceFrame();
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ sourcePage: 1, blockId: 'p1-b2', percent: 0.2 });
    } finally {
      restoreFrames();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('keeps the later block when adjacent blocks share an offset', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    stackTextBlocks(container);
    host.scrollTop = 200;
    // An empty paragraph followed by real text can land on the same offset;
    // the reader should be considered to be on the later block.
    Object.defineProperty(blockElement(container, 'p1-b2', 1), 'offsetTop', {
      configurable: true,
      get: () => 200,
    });
    refreshLayout(host);
    const events: Locator[] = [];
    engine.on('relocated', ({ locator }) => events.push(locator));

    vi.useFakeTimers();
    const restoreFrames = useTimerFrames();
    try {
      dispatchScroll(host);
      advanceFrame();

      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sourcePage: 1, blockId: 'p1-b2' });
    } finally {
      restoreFrames();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('emits when only the visible source page changes', async () => {
    const pack = makePack();
    // Ids only have to be unique per page; reuse one to make the page the only
    // difference between the two visible locators.
    pack.pages[2]!.blocks[1]!.id = 'p1-b1';
    const { engine, container, host } = await openWith(pack);
    scrollMetrics(host);
    stackTextBlocks(container);
    refreshLayout(host);
    const events: Locator[] = [];
    engine.on('relocated', ({ locator }) => events.push(locator));

    vi.useFakeTimers();
    const restoreFrames = useTimerFrames();
    try {
      host.scrollTop = 200;
      dispatchScroll(host);
      advanceFrame();
      expect(events).toHaveLength(1);
      expect(events[0]).toMatchObject({ sourcePage: 1, blockId: 'p1-b1', percent: 0.2 });

      // Reorder the offsets so page 3's duplicate becomes the focused block.
      for (const [blockId, page, top] of [
        ['p1-b2', 1, 300],
        ['p3-b0', 3, 320],
        ['p1-b1', 3, 350],
      ] as const) {
        Object.defineProperty(blockElement(container, blockId, page), 'offsetTop', {
          configurable: true,
          get: () => top,
        });
      }
      refreshLayout(host);

      dispatchScroll(host);
      advanceFrame();
      expect(events).toHaveLength(2);
      expect(events[1]).toMatchObject({ sourcePage: 3, blockId: 'p1-b1', percent: 0.2 });
    } finally {
      restoreFrames();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('keeps a refreshed flash alive past the first flash timer', async () => {
    const { engine, container } = await openWith(makePack());
    const block = blockElement(container, 'p1-b1', 1);
    const locator: Locator = { kind: 'reflow', sourcePage: 1, percent: 0.2, blockId: 'p1-b1' };

    vi.useFakeTimers();
    try {
      await engine.goTo(locator, { flash: true });
      expect(block.classList.contains('bookr-reflow-flash')).toBe(true);

      vi.advanceTimersByTime(800);
      await engine.goTo(locator, { flash: true });
      // Past the first flash's 1200 ms deadline, but only 600 ms after the second.
      vi.advanceTimersByTime(600);
      expect(block.classList.contains('bookr-reflow-flash')).toBe(true);

      vi.advanceTimersByTime(700);
      expect(block.classList.contains('bookr-reflow-flash')).toBe(false);
    } finally {
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('stops scheduling scroll frames after destroy', async () => {
    const { engine, host } = await openWith(makePack());
    await engine.destroy();

    vi.useFakeTimers();
    try {
      dispatchScroll(host);
      // A still-attached listener would schedule the throttled frame; teardown
      // must have aborted it (the container is gone, so it would use a timer).
      expect(vi.getTimerCount()).toBe(0);
      advanceFrame();
    } finally {
      vi.useRealTimers();
    }
  });

  it('applies settings as CSS variables without moving the scroll position', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    await engine.goToPercent(0.4);
    const top = host.scrollTop;

    const settings = {
      ...DEFAULT_READER_SETTINGS,
      reflow: { fontFamily: 'sans' as const, fontSize: 24, lineHeight: 2.2, margin: 12 },
    };
    engine.setSettings(settings);

    const article = container.querySelector('.bookr-reflow') as HTMLElement;
    expect(article.style.getPropertyValue('--reflow-font-size')).toBe('24px');
    expect(article.style.getPropertyValue('--reflow-line-height')).toBe('2.2');
    expect(article.style.getPropertyValue('--reflow-margin')).toBe('12%');
    expect(article.style.getPropertyValue('--reflow-font-family')).toContain('sans-serif');
    expect(host.scrollTop).toBe(top);
    await engine.destroy();
  });

  it('keeps the anchored block and source page when typography reflows', async () => {
    const { engine, container, host } = await openWith(makePack());
    scrollMetrics(host);
    scaleOffsetsWithFontSize(container);
    refreshLayout(host);

    await engine.goTo({ kind: 'reflow', sourcePage: 3, percent: 0.7 });
    expect(host.scrollTop).toBe(600 - 165);
    expect(engine.currentLocator()).toMatchObject({ sourcePage: 3, blockId: 'p3-b0' });

    engine.setSettings({
      ...DEFAULT_READER_SETTINGS,
      reflow: { fontFamily: 'serif', fontSize: 24, lineHeight: 2.2, margin: 12 },
    });

    // The block moved from 600 to 600 * 24/19; the engine re-anchors it rather
    // than keeping the old scrollTop, which would report an earlier page.
    expect(host.scrollTop).toBeCloseTo((600 * 24) / 19 - 165, 5);
    expect(engine.currentLocator()).toMatchObject({ sourcePage: 3, blockId: 'p3-b0' });
    await engine.destroy();
  });

  it('tolerates unknown locator kinds and tears down idempotently', async () => {
    const { engine, container } = await openWith(makePack());
    const epub: Locator = { kind: 'epub', cfi: 'epubcfi(/6/2)', percent: 0.4 };
    await expect(engine.goTo(epub)).resolves.toBeUndefined();
    await engine.destroy();
    await engine.destroy();
    expect(container.childElementCount).toBe(0);
  });
});

function addImageBlock(pack: ReflowPack): void {
  pack.pages[0]!.blocks.push({
    id: 'p1-img',
    type: 'image',
    rect: { x: 0.1, y: 0.2, w: 0.5, h: 0.4 },
  });
}

function visualFigure(container: HTMLElement): HTMLElement {
  const figure = container.querySelector('.bookr-reflow-visual');
  if (!(figure instanceof HTMLElement)) {
    throw new Error('missing visual block');
  }
  return figure;
}

function selectRange(startNode: Node, startOffset: number, endNode: Node, endOffset: number): Range {
  const selection = window.getSelection();
  if (!selection) {
    throw new Error('jsdom has no document selection');
  }
  selection.removeAllRanges();
  const range = document.createRange();
  range.setStart(startNode, startOffset);
  range.setEnd(endNode, endOffset);
  selection.addRange(range);
  return range;
}

describe('reflow selection', () => {
  it('emits a cross-block selection after the 60ms debounce', async () => {
    const { engine, container } = await openWith(makePack());
    const first = blockElement(container, 'p1-b1', 1);
    const second = blockElement(container, 'p1-b2', 1);
    const events: Array<ReaderSelection | null> = [];
    engine.on('selection', (payload) => events.push(payload));

    vi.useFakeTimers();
    try {
      const range = selectRange(first.firstChild as Node, 2, second.firstChild as Node, 2);
      document.dispatchEvent(new Event('selectionchange'));

      // Nothing is emitted before the debounce elapses.
      expect(events).toHaveLength(0);
      vi.advanceTimersByTime(59);
      expect(events).toHaveLength(0);
      vi.advanceTimersByTime(1);

      expect(events).toHaveLength(1);
      const payload = events[0];
      expect(payload).not.toBeNull();
      expect(payload?.text).toBe(range.toString().trim());
      expect(payload?.locator).toMatchObject({
        kind: 'reflow',
        sourcePage: 1,
        blockId: 'p1-b1',
        charRange: [2, (first.textContent as string).length],
      });
      expect((payload?.locator as ReflowLocator).ranges).toEqual([
        { blockId: 'p1-b1', charRange: [2, (first.textContent as string).length] },
        { blockId: 'p1-b2', charRange: [0, 2] },
      ]);
      expect(payload?.rect).toEqual(expect.objectContaining({ left: expect.any(Number) }));
    } finally {
      window.getSelection()?.removeAllRanges();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('reports the page of the element selected when a block id repeats', async () => {
    const pack = makeTwoPagePack();
    // Ids only have to be unique within a page; reuse page 1's id on page 2.
    pack.pages[1]!.blocks[0]!.id = 'p1-b0';
    const { engine, container } = await openWith(pack);
    const secondPageBlock = blockElement(container, 'p1-b0', 2);
    const events: Array<ReaderSelection | null> = [];
    engine.on('selection', (payload) => events.push(payload));

    vi.useFakeTimers();
    try {
      selectRange(
        secondPageBlock.firstChild as Node,
        0,
        secondPageBlock.firstChild as Node,
        2,
      );
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(60);

      expect(events[0]?.locator).toMatchObject({
        kind: 'reflow',
        sourcePage: 2,
        blockId: 'p1-b0',
      });
    } finally {
      window.getSelection()?.removeAllRanges();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('emits null when the selection falls outside the reflow root', async () => {
    const { engine } = await openWith(makePack());
    const outside = document.createElement('p');
    outside.textContent = '外部文字';
    document.body.append(outside);
    const events: Array<ReaderSelection | null> = [];
    engine.on('selection', (payload) => events.push(payload));

    vi.useFakeTimers();
    try {
      selectRange(outside.firstChild as Node, 0, outside.firstChild as Node, 2);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(60);

      expect(events).toEqual([null]);
    } finally {
      window.getSelection()?.removeAllRanges();
      outside.remove();
      vi.useRealTimers();
      await engine.destroy();
    }
  });
});

describe('reflow highlights', () => {
  it('wraps highlighted ranges and removes the marks again', async () => {
    const { engine, container } = await openWith(makePack());
    const block = blockElement(container, 'p1-b1', 1);
    const text = block.textContent as string;

    engine.setHighlights([{
      id: 'h1',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p1-b1', charRange: [0, 2] },
      color: 'yellow',
      hasNote: true,
    }]);

    let marks = block.querySelectorAll('mark.bookr-reflow-mark');
    expect(marks).toHaveLength(1);
    expect(marks[0]?.getAttribute('data-highlight-id')).toBe('h1');
    expect(marks[0]?.classList.contains('has-note')).toBe(true);
    expect(marks[0]?.textContent).toBe(text.slice(0, 2));
    expect(block.textContent).toBe(text);

    engine.setHighlights([]);

    marks = block.querySelectorAll('mark');
    expect(marks).toHaveLength(0);
    expect(block.textContent).toBe(text);

    await engine.destroy();
  });

  it('reports a click on a highlight mark', async () => {
    const { engine, container } = await openWith(makePack());
    const block = blockElement(container, 'p1-b2', 1);
    const clicks: string[] = [];
    engine.on('highlightClick', ({ id }) => clicks.push(id));

    engine.setHighlights([{
      id: 'h2',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p1-b2', charRange: [0, 1] },
      color: 'pink',
      hasNote: false,
    }]);

    window.getSelection()?.removeAllRanges();
    const mark = block.querySelector('[data-highlight-id]') as HTMLElement;
    mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));

    expect(clicks).toEqual(['h2']);
    await engine.destroy();
  });

  it('stops a highlight click from bubbling to the host', async () => {
    const { engine, container } = await openWith(makePack());
    const block = blockElement(container, 'p1-b2', 1);
    const clicks: string[] = [];
    const bubbled = vi.fn();
    engine.on('highlightClick', ({ id }) => clicks.push(id));
    document.body.addEventListener('click', bubbled);

    engine.setHighlights([{
      id: 'h3',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p1-b2', charRange: [0, 1] },
      color: 'blue',
      hasNote: false,
    }]);

    try {
      window.getSelection()?.removeAllRanges();
      const mark = block.querySelector('[data-highlight-id]') as HTMLElement;
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(clicks).toEqual(['h3']);
      expect(bubbled).not.toHaveBeenCalled();
    } finally {
      document.body.removeEventListener('click', bubbled);
      await engine.destroy();
    }
  });

  it('does not open a highlight while text is selected', async () => {
    const { engine, container } = await openWith(makePack());
    const block = blockElement(container, 'p1-b2', 1);
    const clicks: string[] = [];
    engine.on('highlightClick', ({ id }) => clicks.push(id));

    engine.setHighlights([{
      id: 'h4',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p1-b2', charRange: [0, 2] },
      color: 'green',
      hasNote: false,
    }]);

    try {
      const mark = block.querySelector('[data-highlight-id]') as HTMLElement;
      selectRange(mark.firstChild as Node, 0, mark.firstChild as Node, 1);
      mark.dispatchEvent(new MouseEvent('click', { bubbles: true }));

      expect(clicks).toEqual([]);
    } finally {
      window.getSelection()?.removeAllRanges();
      await engine.destroy();
    }
  });

  it('applies highlights only on the block source page', async () => {
    const pack = makePack();
    // Ids only have to be unique per page; reuse page 1's id on page 3.
    pack.pages[2]!.blocks[1]!.id = 'p1-b1';
    const { engine, container } = await openWith(pack);

    engine.setHighlights([{
      id: 'paged',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p1-b1', charRange: [0, 2] },
      color: 'yellow',
      hasNote: false,
    }]);

    const firstPageBlock = blockElement(container, 'p1-b1', 1);
    const thirdPageBlock = blockElement(container, 'p1-b1', 3);
    expect(firstPageBlock.querySelector('mark')?.getAttribute('data-highlight-id')).toBe('paged');
    expect(thirdPageBlock.querySelector('mark')).toBeNull();

    await engine.destroy();
  });

  it('paints a unique block id even when the locator page disagrees', async () => {
    const { engine, container } = await openWith(makePack());
    // The id exists only on page 3, so the element is the authority.
    const block = blockElement(container, 'p3-b1', 3);

    engine.setHighlights([{
      id: 'mismatch',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p3-b1', charRange: [0, 2] },
      color: 'blue',
      hasNote: false,
    }]);

    expect(block.querySelector('mark[data-highlight-id="mismatch"]')).not.toBeNull();
    await engine.destroy();
  });

  it('paints both halves of a cross-page selection', async () => {
    const { engine, container } = await openWith(makeTwoPagePack());
    const first = blockElement(container, 'p1-b0', 1);
    const second = blockElement(container, 'p2-b0', 2);
    const events: Array<ReaderSelection | null> = [];
    engine.on('selection', (payload) => events.push(payload));

    vi.useFakeTimers();
    try {
      // Drag from the middle of page 1's block to the middle of page 2's.
      selectRange(first.firstChild as Node, 2, second.firstChild as Node, 2);
      document.dispatchEvent(new Event('selectionchange'));
      vi.advanceTimersByTime(60);

      const locator = events[0]?.locator;
      expect(locator).toBeDefined();
      engine.setHighlights([{
        id: 'cross',
        locator: locator!,
        color: 'yellow',
        hasNote: false,
      }]);

      // Every range inherits the locator's page, but each block id is unique,
      // so both halves must paint.
      expect(first.querySelector('mark[data-highlight-id="cross"]')).not.toBeNull();
      expect(second.querySelector('mark[data-highlight-id="cross"]')).not.toBeNull();
    } finally {
      window.getSelection()?.removeAllRanges();
      vi.useRealTimers();
      await engine.destroy();
    }
  });

  it('applies highlights that were set before open', async () => {
    const engine = new ReflowReaderEngine({ fetchPack: async () => makePack() });
    const container = document.createElement('div');
    engine.setHighlights([{
      id: 'early',
      locator: { kind: 'reflow', sourcePage: 1, percent: 0, blockId: 'p1-b1', charRange: [0, 2] },
      color: 'purple',
      hasNote: true,
    }]);

    await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);

    const block = blockElement(container, 'p1-b1', 1);
    const mark = block.querySelector('mark.bookr-reflow-mark');
    expect(mark?.getAttribute('data-highlight-id')).toBe('early');
    expect(mark?.classList.contains('has-note')).toBe(true);

    await engine.destroy();
  });
});

describe('reflow visual blocks', () => {
  it('paints every visual block once and destroys the painter', async () => {
    const pack = makePack();
    addImageBlock(pack);
    const paint = vi.fn(
      async (_page: number, _rect: unknown, _canvas: HTMLCanvasElement) => {},
    );
    const load = vi.fn(async () => {});
    const destroy = vi.fn(async () => {});
    const painter = { load, paint, destroy };
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({
      fetchPack: async () => pack,
      painterFactory: () => painter,
    });

    await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS, {
      sourcePdfUrl: 'https://files.test/book.pdf',
    });

    const figure = visualFigure(container);
    const canvas = figure.querySelector('canvas');
    expect(load).toHaveBeenCalledWith('https://files.test/book.pdf');
    expect(paint).toHaveBeenCalledTimes(1);
    expect(paint.mock.calls[0]?.[0]).toBe(1);
    expect(paint.mock.calls[0]?.[2]).toBe(canvas);

    await engine.destroy();
    expect(destroy).toHaveBeenCalledTimes(1);
  });

  it('paints visual blocks from different pages independently', async () => {
    const pack = makePack();
    addImageBlock(pack);
    pack.pages[2]!.blocks.push({
      id: 'p3-img',
      type: 'image',
      rect: { x: 0.1, y: 0.1, w: 0.8, h: 0.4 },
    });
    const paint = vi.fn(
      async (_page: number, _rect: unknown, _canvas: HTMLCanvasElement) => {},
    );
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({
      fetchPack: async () => pack,
      painterFactory: () => ({
        load: async () => {},
        paint,
        destroy: async () => {},
      }),
    });

    await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS, {
      sourcePdfUrl: 'https://files.test/book.pdf',
    });

    expect(container.querySelectorAll('.bookr-reflow-visual')).toHaveLength(2);
    expect(paint).toHaveBeenCalledTimes(2);
    expect(paint.mock.calls.map((call) => call[0]).sort()).toEqual([1, 3]);

    await engine.destroy();
  });

  it('shows the original-page note when painting fails', async () => {
    const pack = makePack();
    addImageBlock(pack);
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({
      fetchPack: async () => pack,
      painterFactory: () => ({
        load: async () => {},
        paint: async () => {
          throw new Error('render failed');
        },
        destroy: async () => {},
      }),
    });

    await expect(engine.open(
      'https://fake-s3.local/pack.json',
      container,
      DEFAULT_READER_SETTINGS,
      { sourcePdfUrl: 'https://files.test/book.pdf' },
    )).resolves.toMatchObject({ kind: 'reflow' });

    const figure = visualFigure(container);
    await vi.waitFor(() => {
      expect(figure.querySelector('canvas')?.style.display).toBe('none');
    });
    expect(figure.textContent).toContain('原文图像暂不可用，可切回原版查看');
    expect(figure.querySelectorAll('.bookr-reflow-visual-note')).toHaveLength(1);

    await engine.destroy();
  });

  it('shows the note immediately without a source PDF URL', async () => {
    const pack = makePack();
    addImageBlock(pack);
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({ fetchPack: async () => pack });

    await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS);

    const figure = visualFigure(container);
    expect(figure.textContent).toContain('原文图像暂不可用，可切回原版查看');
    expect(figure.querySelectorAll('.bookr-reflow-visual-note')).toHaveLength(1);

    await engine.destroy();
  });

  it('observes figures and disconnects on destroy', async () => {
    const pack = makePack();
    addImageBlock(pack);
    const observed: Element[] = [];
    const disconnect = vi.fn();
    class FakeObserver {
      constructor(
        readonly callback: IntersectionObserverCallback,
        readonly options?: IntersectionObserverInit,
      ) {}

      observe = (target: Element): void => {
        observed.push(target);
      };

      unobserve = (): void => {};

      disconnect = disconnect;

      takeRecords = (): IntersectionObserverEntry[] => [];
    }
    vi.stubGlobal('IntersectionObserver', FakeObserver);

    const destroyPainter = vi.fn(async () => {});
    const container = document.createElement('div');
    const engine = new ReflowReaderEngine({
      fetchPack: async () => pack,
      painterFactory: () => ({
        load: async () => {},
        paint: async () => {},
        destroy: destroyPainter,
      }),
    });

    try {
      await engine.open('https://fake-s3.local/pack.json', container, DEFAULT_READER_SETTINGS, {
        sourcePdfUrl: 'https://files.test/book.pdf',
      });

      const figure = visualFigure(container);
      expect(observed).toEqual([figure]);

      await engine.destroy();
      expect(disconnect).toHaveBeenCalledTimes(1);
      expect(destroyPainter).toHaveBeenCalledTimes(1);
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
