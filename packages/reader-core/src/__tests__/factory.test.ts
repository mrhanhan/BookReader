import { expect, it, vi } from 'vitest';

// Keep this suite hermetic: importing the real engines pulls in epubjs/pdfjs,
// which warn (and touch DOM APIs) under Node. The factory contract only needs
// the classes to be constructible.
vi.mock('../pdf/engine', () => ({
  PdfReaderEngine: class PdfReaderEngine {},
}));
vi.mock('../epub/engine', () => ({
  EpubReaderEngine: class EpubReaderEngine {},
}));

import { createReaderEngine } from '../factory';
import { PdfReaderEngine } from '../pdf/engine';
import { EpubReaderEngine } from '../epub/engine';
import { ReflowReaderEngine } from '../reflow/engine';

it('creates the engine that matches the reader kind', () => {
  expect(createReaderEngine('pdf')).toBeInstanceOf(PdfReaderEngine);
  expect(createReaderEngine('epub')).toBeInstanceOf(EpubReaderEngine);
  expect(createReaderEngine('reflow')).toBeInstanceOf(ReflowReaderEngine);
});

it('returns a fresh engine per call', () => {
  expect(createReaderEngine('pdf')).not.toBe(createReaderEngine('pdf'));
  expect(createReaderEngine('epub')).not.toBe(createReaderEngine('epub'));
  expect(createReaderEngine('reflow')).not.toBe(createReaderEngine('reflow'));
});
