import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ReaderSettings } from '../types';

const mock = vi.hoisted(() => ({
  renderCalls: [] as number[],
  failedPages: new Set<number>(),
  pageCount: 10,
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
        cleanup: () => {},
      }),
      getMetadata: async () => ({ info: {} }),
      getOutline: async () => [],
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
