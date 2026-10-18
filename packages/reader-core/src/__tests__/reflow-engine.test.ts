import type { Locator, ReflowBlock, ReflowPack } from '@bookr/shared';
import { describe, expect, it, vi } from 'vitest';
import { ReflowReaderEngine } from '../reflow/engine';
import { renderReflowDocument } from '../reflow/render';
import { DEFAULT_READER_SETTINGS } from '../settings';

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

/** The engine caches offsets; a resize is the public signal that layout moved. */
function refreshLayout(host: HTMLElement): void {
  host.ownerDocument.defaultView?.dispatchEvent(new Event('resize'));
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

    expect(host.scrollTop).toBe(176);
    expect(events.at(-1)?.blockId).toBe('p1-b1');
    expect(engine.currentLocator()).toMatchObject({ kind: 'reflow', sourcePage: 1, blockId: 'p1-b1' });
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
      expect(host.scrollTop).toBe(176);
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

  it('tolerates unknown locator kinds and tears down idempotently', async () => {
    const { engine, container } = await openWith(makePack());
    const epub: Locator = { kind: 'epub', cfi: 'epubcfi(/6/2)', percent: 0.4 };
    await expect(engine.goTo(epub)).resolves.toBeUndefined();
    await engine.destroy();
    await engine.destroy();
    expect(container.childElementCount).toBe(0);
  });
});
