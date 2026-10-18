import { expect, it } from 'vitest';
import { createReaderEngine } from '../factory';
import { PdfReaderEngine } from '../pdf/engine';
import { EpubReaderEngine } from '../epub/engine';

it('creates the engine that matches the reader kind', () => {
  expect(createReaderEngine('pdf')).toBeInstanceOf(PdfReaderEngine);
  expect(createReaderEngine('epub')).toBeInstanceOf(EpubReaderEngine);
});
