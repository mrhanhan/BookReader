import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReaderSettings } from '../types';

const mock = vi.hoisted(() => ({
  renderCalls: [] as number[],
  failedPages: new Set<number>(),
  pageCount: 10,
  textByPage: {} as Record<number, Array<{ str: string; hasEOL?: boolean }>>,
  outline: [] as Array<{ title: string; dest: unknown }>,
}));

vi.mock('pdfjs-dist', () => ({
  GlobalWorkerOptions: { workerSrc: '' },
  getDocument: () => ({
    promise: Promise.resolve({
      numPages: mock.pageCount,
      getPage: async (pageNumber: number) => ({
        getViewport: ({ scale = 1 }: { scale?: number } = {}) => ({
          width: 600 * scale,
          height: 800 * scale,
        }),
        render: () => {
          mock.renderCalls.push(pageNumber);
          return {
            promise: mock.failedPages.has(pageNumber)
              ? Promise.reject(new Error(`page ${pageNumber} failed`))
              : Promise.resolve(),
            cancel: () => {},
          };
        },
        streamTextContent: () => ({ items: [], styles: {} }),
        getTextContent: async () => ({ items: mock.textByPage[pageNumber] ?? [] }),
        cleanup: () => {},
      }),
      getMetadata: async () => ({ info: {} }),
      getOutline: async () => mock.outline,
      getPageIndex: async (ref: { num?: number }) => (ref.num ?? 1) - 1,
      cleanup: () => {},
    }),
    destroy: async () => {},
  }),
  TextLayer: class {
    render(): Promise<void> {
      return Promise.resolve();
    }
    cancel(): void {}
  },
}));

import { PdfReaderEngine } from '../pdf/engine';

const originalGetContext = HTMLCanvasElement.prototype.getContext;
const context2d = {
  setTransform: () => {},
  clearRect: () => {},
  getImageData: () => ({ data: new Uint8ClampedArray(0) }),
} as unknown as CanvasRenderingContext2D;

function settingsFor(mode: ReaderSettings['pdf']['mode']): ReaderSettings {
  return {
    theme: 'paper',
    brightness: 1,
    pdf: {
      mode,
      zoom: 1,
      crop: 'none',
      cropAdjust: { top: 0, right: 0, bottom: 0, left: 0 },
      readingMode: 'original',
    },
    epub: {
      flow: 'paginated',
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.8,
      margin: 6,
      spread: 'none',
    },
    reflow: {
      fontFamily: 'serif',
      fontSize: 19,
      lineHeight: 1.9,
      margin: 7,
    },
  };
}

function uniqueRenderCalls(): number[] {
  return [...new Set(mock.renderCalls)].sort((left, right) => left - right);
}

function renderedPageNumbers(container: HTMLElement): string[] {
  return [...container.querySelectorAll<HTMLElement>('.bookr-pdf-page')].map(
    (slot) => slot.dataset.page ?? '',
  );
}

function scrollHostOf(container: HTMLElement): HTMLElement {
  const host = container.querySelector<HTMLElement>('.bookr-pdf-scroll');
  if (!host) {
    throw new Error('scroll host missing');
  }
  return host;
}

/**
 * jsdom has no layout engine, so scroll sizes and offsets stay 0 unless the
 * test provides them. `scrollLeft`/`scrollTop` remain writable properties.
 */
function stubScrollMetrics(
  host: HTMLElement,
  metrics: { scrollWidth: number; clientWidth: number; scrollHeight: number; clientHeight: number },
): void {
  for (const [key, value] of Object.entries(metrics)) {
    Object.defineProperty(host, key, { value, configurable: true });
  }
}

async function openReader(
  mode: ReaderSettings['pdf']['mode'],
  initialPage?: number,
): Promise<{ engine: PdfReaderEngine; container: HTMLElement; pageCount: number }> {
  const container = document.createElement('div');
  document.body.append(container);
  const engine = new PdfReaderEngine();
  const pageCount = mock.pageCount;
  const info = await engine.open(
    'https://files.test/book.pdf',
    container,
    settingsFor(mode),
    initialPage === undefined
      ? {}
      : {
          initialLocator: {
            kind: 'pdf',
            page: initialPage,
            percent: (initialPage - 1) / pageCount,
          },
        },
  );
  return { engine, container, pageCount: info.pageCount ?? 0 };
}

beforeEach(() => {
  mock.renderCalls.length = 0;
  mock.failedPages.clear();
  mock.pageCount = 10;
  mock.textByPage = {};
  mock.outline = [];
  HTMLCanvasElement.prototype.getContext = (() =>
    context2d) as unknown as typeof HTMLCanvasElement.prototype.getContext;
});

afterEach(() => {
  HTMLCanvasElement.prototype.getContext = originalGetContext;
  document.body.replaceChildren();
});

it('paints both pages of the opening spread in two-page mode', async () => {
  const { engine, container } = await openReader('double');
  try {
    // Both pages of the first spread must have called pdf.js render before
    // `open` resolved; the second page used to stay blank until navigation.
    expect(uniqueRenderCalls()).toEqual([1, 2]);

    const slots = [...container.querySelectorAll<HTMLElement>('.bookr-pdf-page')];
    expect(slots.map((slot) => slot.dataset.page)).toEqual(['1', '2']);
    for (const slot of slots) {
      const canvas = slot.querySelector('canvas');
      expect(canvas).not.toBeNull();
      expect(canvas?.width ?? 0).toBeGreaterThan(0);
      expect(canvas?.height ?? 0).toBeGreaterThan(0);
    }
  } finally {
    await engine.destroy();
  }
});

it('paints only the current page in single-page mode', async () => {
  const { engine, container } = await openReader('single');
  try {
    expect(uniqueRenderCalls()).toEqual([1]);
    expect(renderedPageNumbers(container)).toEqual(['1']);
  } finally {
    await engine.destroy();
  }
});

it('paints the spread around an initial locator', async () => {
  const { engine, container } = await openReader('double', 3);
  try {
    expect(uniqueRenderCalls()).toEqual([1, 2, 3, 4]);
    expect(renderedPageNumbers(container)).toEqual(['3', '4']);
    for (const slot of container.querySelectorAll<HTMLElement>('.bookr-pdf-page')) {
      const canvas = slot.querySelector('canvas');
      expect(canvas?.width ?? 0).toBeGreaterThan(0);
      expect(canvas?.height ?? 0).toBeGreaterThan(0);
    }
  } finally {
    await engine.destroy();
  }
});

it('keeps opening when one page of the spread fails to render', async () => {
  mock.failedPages.add(2);
  const container = document.createElement('div');
  document.body.append(container);
  const engine = new PdfReaderEngine();
  const errors: Array<{ code: string; message: string }> = [];
  engine.on('error', (payload) => errors.push(payload));

  try {
    const info = await engine.open('https://files.test/book.pdf', container, settingsFor('double'));
    expect(info.pageCount).toBe(10);
    expect(uniqueRenderCalls()).toEqual([1, 2]);
    expect(errors).toContainEqual(
      expect.objectContaining({ code: 'render-failed', message: 'page 2 failed' }),
    );
  } finally {
    await engine.destroy();
  }
});

it('maps a reflow locator onto its source page', async () => {
  const { engine, container } = await openReader('single');
  try {
    await engine.goTo({ kind: 'reflow', sourcePage: 5, percent: 0.5 });

    expect(engine.currentLocator()).toMatchObject({ kind: 'pdf', page: 5 });
    expect(renderedPageNumbers(container)).toEqual(['5']);
  } finally {
    await engine.destroy();
  }
});

it('clamps a reflow locator page into the document', async () => {
  const { engine } = await openReader('single');
  try {
    await engine.goTo({ kind: 'reflow', sourcePage: 99, percent: 1 });

    expect(engine.currentLocator()).toMatchObject({ kind: 'pdf', page: mock.pageCount });
  } finally {
    await engine.destroy();
  }
});

it('returns page and outline chapter text for the AI companion', async () => {
  mock.textByPage = {
    1: [{ str: '第一章开头' }],
    2: [{ str: '本页第一句。' }, { str: '本页第二句。' }],
    3: [{ str: '第二章开头' }],
  };
  mock.outline = [
    { title: '第一章', dest: [{ num: 1 }] },
    { title: '第二章', dest: [{ num: 3 }] },
  ];
  const { engine } = await openReader('single', 2);
  try {
    const page = await engine.getTextContext('page');
    expect(page).toMatchObject({ scope: 'page', label: '第 2 页' });
    expect(page.text).toContain('本页第一句');

    const chapter = await engine.getTextContext('chapter');
    expect(chapter.text).toContain('本页第一句');
    expect(chapter.text).not.toContain('第二章开头');
  } finally {
    await engine.destroy();
  }
});

it('falls back to a 20-page chapter window when the PDF has no outline', async () => {
  mock.pageCount = 25;
  mock.outline = [];
  mock.textByPage = {};
  for (let page = 1; page <= 25; page += 1) {
    mock.textByPage[page] = [{ str: `第 ${page} 页正文` }];
  }
  const { engine } = await openReader('single', 5);
  try {
    const chapter = await engine.getTextContext('chapter');
    // The per-page fallback TOC must not collapse the chapter to one page.
    expect(chapter.text).toContain('第 5 页正文');
    expect(chapter.text).toContain('第 24 页正文');
    expect(chapter.text).not.toContain('第 25 页正文');
  } finally {
    await engine.destroy();
  }
});

it('reports the remaining scroll room on both axes', async () => {
  const { engine, container } = await openReader('single');
  try {
    expect(typeof engine.canScroll).toBe('function');
    const host = scrollHostOf(container);
    stubScrollMetrics(host, {
      scrollWidth: 900, clientWidth: 360, scrollHeight: 800, clientHeight: 600,
    });
    host.scrollLeft = 100;
    host.scrollTop = 100;

    expect(engine.canScroll?.('x', 1)).toBe(true);
    expect(engine.canScroll?.('x', -1)).toBe(true);
    expect(engine.canScroll?.('y', 1)).toBe(true);
    expect(engine.canScroll?.('y', -1)).toBe(true);

    // At the far edge there is no forward room left, at the origin no way back.
    host.scrollLeft = 540;
    host.scrollTop = 200;
    expect(engine.canScroll?.('x', 1)).toBe(false);
    expect(engine.canScroll?.('y', 1)).toBe(false);
    host.scrollLeft = 0;
    host.scrollTop = 0;
    expect(engine.canScroll?.('x', -1)).toBe(false);
    expect(engine.canScroll?.('y', -1)).toBe(false);
  } finally {
    await engine.destroy();
  }
});

it('reports no scroll room when the content fits or the metrics are unusable', async () => {
  const { engine, container } = await openReader('single');
  try {
    const host = scrollHostOf(container);
    stubScrollMetrics(host, {
      scrollWidth: 360, clientWidth: 360, scrollHeight: 600, clientHeight: 600,
    });
    expect(engine.canScroll?.('x', 1)).toBe(false);
    expect(engine.canScroll?.('x', -1)).toBe(false);
    expect(engine.canScroll?.('y', 1)).toBe(false);
    expect(engine.canScroll?.('y', -1)).toBe(false);

    // A NaN offset from a torn-down host must not compare as scrollable.
    host.scrollLeft = Number.NaN;
    host.scrollTop = Number.NaN;
    expect(engine.canScroll?.('x', 1)).toBe(false);
    expect(engine.canScroll?.('y', 1)).toBe(false);
  } finally {
    await engine.destroy();
  }
});

it.each(['single', 'double'] as const)(
  'resets the scroll offset after a page flip in %s mode',
  async (mode) => {
    const { engine, container } = await openReader(mode);
    try {
      const host = scrollHostOf(container);
      host.scrollLeft = 120;
      host.scrollTop = 240;

      await engine.next();

      expect(host.scrollLeft).toBe(0);
      expect(host.scrollTop).toBe(0);
    } finally {
      await engine.destroy();
    }
  },
);
