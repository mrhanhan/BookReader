import { READER_THEME_COLORS } from '../settings';
import type { EpubFontFamily, ReaderSettings, ReaderThemeName } from '../types';

/** Every theme the EPUB rendition registers; kept in registry order. */
export const EPUB_THEME_NAMES = [
  'paper',
  'sepia',
  'green',
  'dark',
] as const satisfies readonly ReaderThemeName[];

/** Font stacks are injected into the iframe so books keep our typography. */
export const EPUB_FONT_STACKS: Record<EpubFontFamily, string> = {
  serif:
    '"Iowan Old Style", "Palatino Linotype", Palatino, Georgia, "Songti SC", "Noto Serif SC", serif',
  sans: '"Helvetica Neue", Helvetica, Arial, "PingFang SC", "Noto Sans SC", sans-serif',
};

export function epubFontStack(family: EpubFontFamily): string {
  return EPUB_FONT_STACKS[family];
}

/**
 * CSS injected into every EPUB section for one reading theme. Background and
 * foreground are the exact paper/ink colors from `READER_THEME_COLORS`.
 */
export function epubThemeCss(name: ReaderThemeName): string {
  const { background, foreground } = READER_THEME_COLORS[name];
  return [
    `body { background: ${background}; color: ${foreground}; }`,
    `a { color: ${foreground}; }`,
  ].join('\n');
}

/**
 * Typography overrides, applied through epub.js' inline-style override layer so
 * they beat the book's own stylesheet. The margin is the same on both sides and
 * the vertical breathing room is fixed at 2%.
 */
export function epubOverrides(settings: ReaderSettings): Array<[string, string]> {
  const { fontSize, lineHeight, margin } = settings.epub;
  return [
    ['font-size', `${fontSize}px`],
    ['line-height', String(lineHeight)],
    ['padding-left', `${margin}%`],
    ['padding-right', `${margin}%`],
    ['padding-top', '2%'],
    ['padding-bottom', '2%'],
  ];
}
