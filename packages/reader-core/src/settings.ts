import type { AnnotationColor } from '@bookr/shared';
import { clamp } from './locator';
import type {
  EpubFlow,
  EpubFontFamily,
  PdfLayoutMode,
  ReaderSettings,
  ReaderThemeName,
} from './types';

export interface ReaderThemeColors {
  background: string;
  foreground: string;
}

/** Paper/ink colors per reading theme; the web stylesheet maps these to CSS. */
export const READER_THEME_COLORS: Record<ReaderThemeName, ReaderThemeColors> = {
  paper: { background: '#F6F1E7', foreground: '#2B2620' },
  sepia: { background: '#F2E4C9', foreground: '#3A2E20' },
  green: { background: '#E4EBDD', foreground: '#2C3327' },
  dark: { background: '#1C1A17', foreground: '#E6DECF' },
};

/** Highlight fill colors keyed by annotation color. */
export const HIGHLIGHT_HEX: Record<AnnotationColor, string> = {
  yellow: '#E8C56B',
  green: '#9BBF8A',
  blue: '#8FB4C9',
  pink: '#D9A6A0',
  purple: '#B3A0C6',
};

const THEMES = ['paper', 'sepia', 'green', 'dark'] as const satisfies readonly ReaderThemeName[];
const PDF_MODES = ['continuous', 'single', 'double'] as const satisfies readonly PdfLayoutMode[];
const PDF_CROPS = ['auto', 'none'] as const;
const EPUB_FLOWS = ['paginated', 'scrolled'] as const satisfies readonly EpubFlow[];
const EPUB_FONTS = ['serif', 'sans'] as const satisfies readonly EpubFontFamily[];
const EPUB_SPREADS = ['none', 'auto'] as const;

/** Fresh defaults on every call so callers cannot mutate shared state. */
function defaultReaderSettings(): ReaderSettings {
  return {
    theme: 'paper',
    brightness: 1,
    pdf: {
      mode: 'continuous',
      zoom: 'fit-width',
      crop: 'auto',
      cropAdjust: { top: 0, right: 0, bottom: 0, left: 0 },
    },
    epub: {
      flow: 'paginated',
      fontFamily: 'serif',
      fontSize: 18,
      lineHeight: 1.8,
      margin: 6,
      spread: 'none',
    },
  };
}

/** Baseline reader settings, matching the server-side defaults. */
export const DEFAULT_READER_SETTINGS: ReaderSettings = defaultReaderSettings();

function asRecord(value: unknown): Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function pickEnum<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  return typeof value === 'string' && (allowed as readonly string[]).includes(value)
    ? (value as T)
    : fallback;
}

function pickNumber(value: unknown, fallback: number, min: number, max: number): number {
  return typeof value === 'number' && Number.isFinite(value)
    ? clamp(value, min, max)
    : fallback;
}

function pickZoom(value: unknown): ReaderSettings['pdf']['zoom'] {
  if (value === 'fit-width' || value === 'fit-page') {
    return value;
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    return clamp(value, 0.5, 4);
  }
  return 'fit-width';
}

function mergeSettings(value: unknown): ReaderSettings {
  const source = asRecord(value);
  const pdf = asRecord(source.pdf);
  const epub = asRecord(source.epub);
  const cropAdjust = asRecord(pdf.cropAdjust);

  return {
    theme: pickEnum(source.theme, THEMES, 'paper'),
    brightness: pickNumber(source.brightness, 1, 0.6, 1.2),
    pdf: {
      mode: pickEnum(pdf.mode, PDF_MODES, 'continuous'),
      zoom: pickZoom(pdf.zoom),
      crop: pickEnum(pdf.crop, PDF_CROPS, 'auto'),
      cropAdjust: {
        top: pickNumber(cropAdjust.top, 0, 0, 10),
        right: pickNumber(cropAdjust.right, 0, 0, 10),
        bottom: pickNumber(cropAdjust.bottom, 0, 0, 10),
        left: pickNumber(cropAdjust.left, 0, 0, 10),
      },
    },
    epub: {
      flow: pickEnum(epub.flow, EPUB_FLOWS, 'paginated'),
      fontFamily: pickEnum(epub.fontFamily, EPUB_FONTS, 'serif'),
      fontSize: pickNumber(epub.fontSize, 18, 14, 28),
      lineHeight: pickNumber(epub.lineHeight, 1.8, 1.4, 2.4),
      margin: pickNumber(epub.margin, 6, 2, 12),
      spread: pickEnum(epub.spread, EPUB_SPREADS, 'none'),
    },
  };
}

/**
 * Merges persisted or caller-supplied settings over the defaults, field by
 * field. Arbitrary input (including nested garbage and hostile getters) can
 * never throw; invalid fields simply fall back to the default.
 */
export function mergeReaderSettings(value: unknown): ReaderSettings {
  try {
    return mergeSettings(value);
  } catch {
    return defaultReaderSettings();
  }
}
