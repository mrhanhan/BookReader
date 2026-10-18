import { useCallback } from 'react';
import type { BookDto, ReaderKind } from '@bookr/shared';
import type {
  PdfReadingMode,
  ReaderEngineKind,
  ReaderSettings,
} from '@bookr/reader-core';

export interface ReadingModeInput {
  book: BookDto | null;
  bookKind: ReaderKind | null;
  /** True once the signed reflow pack URL has been fetched successfully. */
  reflowReady: boolean;
  settings: ReaderSettings;
  onSwitch: (next: PdfReadingMode) => void;
}

export interface ReadingModeState {
  /** The engine kind to render; null while the book kind is unknown. */
  mode: ReaderEngineKind | null;
  reflowAvailable: boolean;
  toggleReflow: () => void;
}

/**
 * Derives the effective reading mode from the book, the fetched pack URL and
 * the persisted preference. EPUB books never enter reflow; a PDF only does
 * once its pack URL has arrived, so the engine is never created without one.
 */
export function useReadingMode({
  book,
  bookKind,
  reflowReady,
  settings,
  onSwitch,
}: ReadingModeInput): ReadingModeState {
  const reflowAvailable =
    book != null && book.format === 'pdf' && book.reflowAvailable;

  const mode: ReaderEngineKind | null =
    bookKind === 'epub'
      ? 'epub'
      : bookKind === 'pdf'
        ? reflowAvailable && reflowReady && settings.pdf.readingMode === 'reflow'
          ? 'reflow'
          : 'pdf'
        : null;

  const toggleReflow = useCallback(() => {
    if (!reflowAvailable) return;
    onSwitch(mode === 'reflow' ? 'original' : 'reflow');
  }, [mode, onSwitch, reflowAvailable]);

  return { mode, reflowAvailable, toggleReflow };
}
