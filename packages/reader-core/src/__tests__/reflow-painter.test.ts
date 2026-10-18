import { describe, expect, it, vi } from 'vitest';

import {
  SourcePagePainter,
  normalizedCrop,
  type PainterDocument,
  type PainterPage,
} from '../reflow/source-painter';

describe('normalizedCrop', () => {
  it('maps normalized rects into bitmap pixels', () => {
    expect(normalizedCrop({ x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, 1000, 2000)).toEqual({
      sx: 100,
      sy: 400,
      sw: 500,
      sh: 800,
    });
  });

  it('clamps the crop into the bitmap', () => {
    expect(normalizedCrop({ x: 0.8, y: 0.9, w: 0.5, h: 0.5 }, 1000, 2000)).toEqual({
      sx: 800,
      sy: 1800,
      sw: 200,
      sh: 200,
    });
    expect(normalizedCrop({ x: -0.1, y: -0.2, w: 0.3, h: 0.2 }, 1000, 2000)).toEqual({
      sx: 0,
      sy: 0,
      sw: 300,
      sh: 400,
    });
    expect(normalizedCrop({ x: Number.NaN, y: 0.1, w: 0.2, h: 0.2 }, 1000, 2000)).toEqual({
      sx: 0,
      sy: 200,
      sw: 200,
      sh: 400,
    });
  });
});

function fakePage(): PainterPage {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }),
    render: () => ({ promise: Promise.resolve(), cancel: () => {} }),
  };
}

function fakeDocument(): PainterDocument {
  return {
    numPages: 2,
    getPage: async () => fakePage(),
  };
}

function letterPage(renderCalls?: number[], pageNumber = 1): PainterPage {
  return {
    getViewport: ({ scale }: { scale: number }) => ({
      width: 612 * scale,
      height: 792 * scale,
    }),
    render: () => {
      renderCalls?.push(pageNumber);
      return { promise: Promise.resolve(), cancel: () => {} };
    },
  };
}

interface FakeContext {
  setTransform: ReturnType<typeof vi.fn>;
  clearRect: ReturnType<typeof vi.fn>;
  drawImage: ReturnType<typeof vi.fn>;
}

/** jsdom has no canvas backend; stub the 2D context to observe drawing. */
function install2dContext(): { context: FakeContext; restore: () => void } {
  const context: FakeContext = {
    setTransform: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
  };
  const original = HTMLCanvasElement.prototype.getContext;
  HTMLCanvasElement.prototype.getContext = (() =>
    context) as unknown as typeof HTMLCanvasElement.prototype.getContext;
  return {
    context,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

describe('SourcePagePainter', () => {
  it('loads a document through the injected loader', async () => {
    const painter = new SourcePagePainter({}, async () => fakeDocument());

    await expect(painter.load('https://files.test/book.pdf')).resolves.toBeUndefined();

    await painter.destroy();
  });

  it('rejects paint when the host has no 2D canvas context', async () => {
    const painter = new SourcePagePainter({}, async () => fakeDocument());
    await painter.load('https://files.test/book.pdf');
    const canvas = document.createElement('canvas');

    // jsdom ships no canvas implementation, so this is the unsupported-host
    // path the engine relies on to show the original-page fallback.
    await expect(
      painter.paint(1, { x: 0.1, y: 0.2, w: 0.5, h: 0.4 }, canvas),
    ).rejects.toThrow('Canvas is unavailable');

    await painter.destroy();
  });

  it('stops loading and painting after destroy', async () => {
    const painter = new SourcePagePainter({}, async () => fakeDocument());
    await painter.load('https://files.test/book.pdf');
    await painter.destroy();
    const canvas = document.createElement('canvas');

    await expect(
      painter.paint(1, { x: 0, y: 0, w: 1, h: 1 }, canvas),
    ).rejects.toThrow();
  });

  it('paints a crop with the page aspect ratio and DPR-sized bitmap', async () => {
    const page = letterPage();
    const painter = new SourcePagePainter({}, async () => ({
      numPages: 2,
      getPage: async () => page,
    }));
    await painter.load('https://files.test/book.pdf');
    const canvas = document.createElement('canvas');
    const { context, restore } = install2dContext();

    try {
      await painter.paint(1, { x: 0.5, y: 0.5, w: 0.5, h: 0.5 }, canvas);
    } finally {
      restore();
      await painter.destroy();
    }

    // 640 CSS px fallback width: a Letter page gives h/w ≈ 1.294.
    expect(canvas.width).toBe(640);
    expect(canvas.height).toBe(828);
    expect(canvas.height / canvas.width).toBeCloseTo(792 / 612, 2);
    expect(context.drawImage).toHaveBeenCalledTimes(1);
    const args = context.drawImage.mock.calls[0] as unknown[];
    expect(args.slice(1)).toEqual([320, 414, 320, 414, 0, 0, 640, 828]);
  });

  it('renders a page once for repeated paints', async () => {
    const renderCalls: number[] = [];
    const page = letterPage(renderCalls);
    const painter = new SourcePagePainter({}, async () => ({
      numPages: 2,
      getPage: async () => page,
    }));
    await painter.load('https://files.test/book.pdf');
    const { restore } = install2dContext();

    try {
      await painter.paint(1, { x: 0, y: 0, w: 1, h: 1 }, document.createElement('canvas'));
      await painter.paint(1, { x: 0, y: 0, w: 1, h: 1 }, document.createElement('canvas'));

      expect(renderCalls).toEqual([1]);
    } finally {
      restore();
      await painter.destroy();
    }
  });

  it('shares an in-flight page render between concurrent paints', async () => {
    let resolveRender: (() => void) | undefined;
    const render = vi.fn(() => ({
      promise: new Promise<void>((resolve) => {
        resolveRender = resolve;
      }),
      cancel: () => {},
    }));
    const page: PainterPage = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
      render,
    };
    const painter = new SourcePagePainter({}, async () => ({
      numPages: 2,
      getPage: async () => page,
    }));
    await painter.load('https://files.test/book.pdf');
    const { restore } = install2dContext();

    try {
      const first = painter.paint(1, { x: 0, y: 0, w: 1, h: 1 }, document.createElement('canvas'));
      const second = painter.paint(1, { x: 0, y: 0, w: 1, h: 1 }, document.createElement('canvas'));

      await vi.waitFor(() => {
        expect(render).toHaveBeenCalledTimes(1);
      });
      resolveRender?.();
      await Promise.all([first, second]);

      expect(render).toHaveBeenCalledTimes(1);
    } finally {
      restore();
      await painter.destroy();
    }
  });

  it('evicts the least recently used page beyond the cache cap', async () => {
    const renderCalls: number[] = [];
    const pages = new Map<number, PainterPage>();
    const painter = new SourcePagePainter({}, async () => ({
      numPages: 20,
      getPage: async (pageNumber: number) => {
        let page = pages.get(pageNumber);
        if (!page) {
          page = letterPage(renderCalls, pageNumber);
          pages.set(pageNumber, page);
        }
        return page;
      },
    }));
    await painter.load('https://files.test/book.pdf');
    const { restore } = install2dContext();
    const rect = { x: 0, y: 0, w: 1, h: 1 };

    try {
      for (let pageNumber = 1; pageNumber <= 9; pageNumber += 1) {
        await painter.paint(pageNumber, rect, document.createElement('canvas'));
      }
      expect(renderCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);

      // Page 1 fell out of the 8-page cache, page 9 is still warm.
      await painter.paint(1, rect, document.createElement('canvas'));
      expect(renderCalls).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 1]);

      await painter.paint(9, rect, document.createElement('canvas'));
      expect(renderCalls).toHaveLength(10);
    } finally {
      restore();
      await painter.destroy();
    }
  });

  it('releases a document that finishes loading after destroy', async () => {
    let resolveLoad: ((document: PainterDocument) => void) | undefined;
    const destroyDocument = vi.fn(async () => {});
    const painter = new SourcePagePainter(
      {},
      () =>
        new Promise<PainterDocument>((resolve) => {
          resolveLoad = resolve;
        }),
    );
    const loading = painter.load('https://files.test/book.pdf');
    await painter.destroy();

    resolveLoad?.({
      numPages: 1,
      getPage: async () => fakePage(),
      destroy: destroyDocument,
    } as unknown as PainterDocument);

    await expect(loading).rejects.toThrow('The page painter was destroyed');
    expect(destroyDocument).toHaveBeenCalledTimes(1);
  });

  it('does not draw when destroy invalidates an in-flight render', async () => {
    let resolveRender: (() => void) | undefined;
    const render = vi.fn(() => ({
      promise: new Promise<void>((resolve) => {
        resolveRender = resolve;
      }),
      cancel: () => {},
    }));
    const page: PainterPage = {
      getViewport: ({ scale }: { scale: number }) => ({ width: 612 * scale, height: 792 * scale }),
      render,
    };
    const painter = new SourcePagePainter({}, async () => ({
      numPages: 2,
      getPage: async () => page,
    }));
    await painter.load('https://files.test/book.pdf');
    const { context, restore } = install2dContext();
    const canvas = document.createElement('canvas');

    try {
      const painting = painter.paint(1, { x: 0, y: 0, w: 1, h: 1 }, canvas);
      await vi.waitFor(() => {
        expect(render).toHaveBeenCalledTimes(1);
      });
      await painter.destroy();
      resolveRender?.();

      await expect(painting).rejects.toThrow('The page painter was destroyed');
      expect(context.drawImage).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });
});
