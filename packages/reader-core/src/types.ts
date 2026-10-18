import type { AnnotationColor, Locator, ReaderKind } from '@bookr/shared';

export type ReaderThemeName = 'paper' | 'sepia' | 'green' | 'dark';
export type PdfLayoutMode = 'continuous' | 'single' | 'double';
export type EpubFlow = 'paginated' | 'scrolled';
export type EpubFontFamily = 'serif' | 'sans';

export interface ReaderSettings {
  theme: ReaderThemeName;
  brightness: number; // 0.6–1.2
  pdf: {
    mode: PdfLayoutMode; zoom: number | 'fit-width' | 'fit-page';
    crop: 'auto' | 'none';
    cropAdjust: { top: number; right: number; bottom: number; left: number }; // 0–10 (%)
  };
  epub: {
    flow: EpubFlow; fontFamily: EpubFontFamily; fontSize: number;
    lineHeight: number; margin: number; spread: 'none' | 'auto';
  };
}

export interface ReaderSelection {
  text: string;
  locator: Locator;
  /** Viewport CSS pixels, for positioning the floating menu. */
  rect: { left: number; top: number; width: number; height: number };
}
export interface ReaderHighlight {
  id: string; locator: Locator; color: AnnotationColor; hasNote: boolean;
}
export interface TocItem {
  id: string; label: string; depth: number; locator: Locator; children: TocItem[];
}
export interface ReaderDocumentInfo {
  kind: ReaderKind; title: string | null; pageCount: number | null; toc: TocItem[];
}
export interface ReaderEventMap {
  relocated: { locator: Locator; percent: number };
  selection: ReaderSelection | null;
  highlightClick: { id: string };
  error: { code: 'load-failed' | 'render-failed'; message: string };
}
export interface OpenReaderOptions {
  initialLocator?: Locator;
  workerSrc?: string;           // pdf.js worker URL, supplied by the web build
  cMapUrl?: string;             // PDF CMaps, default '/cmaps/'
  standardFontDataUrl?: string; // PDF standard fonts, default '/standard_fonts/'
}
export interface ReaderEngine {
  readonly kind: ReaderKind;
  open(url: string, container: HTMLElement, settings: ReaderSettings, options?: OpenReaderOptions): Promise<ReaderDocumentInfo>;
  goTo(locator: Locator, options?: { flash?: boolean }): Promise<void>;
  goToPercent(percent: number): Promise<void>;
  next(): Promise<void>;
  previous(): Promise<void>;
  currentLocator(): Locator;
  setSettings(settings: ReaderSettings): void;
  setHighlights(highlights: ReaderHighlight[]): void;
  on<K extends keyof ReaderEventMap>(event: K, listener: (payload: ReaderEventMap[K]) => void): () => void;
  destroy(): Promise<void>;
}
