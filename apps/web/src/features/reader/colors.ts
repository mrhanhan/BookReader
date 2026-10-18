import { READER_THEME_COLORS } from '@bookr/reader-core';
import type { ReaderThemeName } from '@bookr/reader-core';

export interface ReaderThemeOption {
  value: ReaderThemeName;
  label: string;
  /** Accessible name pinned by the reading-control tests. */
  ariaLabel: string;
  swatch: string;
  ink: string;
}

function option(
  value: ReaderThemeName,
  label: string,
  ariaLabel: string,
): ReaderThemeOption {
  const colors = READER_THEME_COLORS[value];
  return { value, label, ariaLabel, swatch: colors.background, ink: colors.foreground };
}

/** Reading themes, ordered from the lightest paper to the night theme. */
export const READER_THEME_OPTIONS: ReaderThemeOption[] = [
  option('paper', '纸白', '纸白主题'),
  option('sepia', '米黄', '米黄主题'),
  option('green', '护眼绿', '护眼绿主题'),
  option('dark', '深色', '深色主题'),
];
