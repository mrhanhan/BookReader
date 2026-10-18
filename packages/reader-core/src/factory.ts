import type { ReaderKind } from '@bookr/shared';

import { EpubReaderEngine } from './epub/engine';
import { PdfReaderEngine } from './pdf/engine';
import type { ReaderEngine } from './types';

/** Creates the engine that renders the given book kind. */
export function createReaderEngine(kind: ReaderKind): ReaderEngine {
  return kind === 'epub' ? new EpubReaderEngine() : new PdfReaderEngine();
}
