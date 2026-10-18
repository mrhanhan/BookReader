import { READER_THEME_COLORS } from '@bookr/reader-core';
import type { ReaderThemeName } from '@bookr/reader-core';
import { ANNOTATION_COLORS } from '@bookr/shared';
import type { AnnotationColor } from '@bookr/shared';

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

/** Chinese names of the five highlight colors. */
export const ANNOTATION_COLOR_LABELS: Record<AnnotationColor, string> = {
  yellow: '黄色',
  green: '绿色',
  blue: '蓝色',
  pink: '粉色',
  purple: '紫色',
};

/** Accessible names of the selection-menu color actions. */
export const HIGHLIGHT_ACTION_LABELS: Record<AnnotationColor, string> = {
  yellow: '用黄色划线',
  green: '用绿色划线',
  blue: '用蓝色划线',
  pink: '用粉色划线',
  purple: '用紫色划线',
};

/** Ordered palette for the selection menu and the annotation dialog swatches. */
export const ANNOTATION_COLOR_OPTIONS = ANNOTATION_COLORS.map((color) => ({
  color,
  label: ANNOTATION_COLOR_LABELS[color],
  actionLabel: HIGHLIGHT_ACTION_LABELS[color],
}));
