import { EpubReaderEngine } from './epub/engine';
import { PdfReaderEngine } from './pdf/engine';
import { ReflowReaderEngine } from './reflow/engine';
import type { ReaderEngine, ReaderEngineKind } from './types';

/** Creates the engine that renders the given book kind. */
export function createReaderEngine(kind: ReaderEngineKind): ReaderEngine {
  if (kind === 'epub') {
    return new EpubReaderEngine();
  }
  if (kind === 'reflow') {
    return new ReflowReaderEngine();
  }
  return new PdfReaderEngine();
}
