import { describe, expect, it } from 'vitest';

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
});
