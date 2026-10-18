/**
 * Paper-ink design tokens.
 *
 * Keep these values in sync with `theme.css`, which declares the same palette
 * as CSS custom properties and Tailwind 4 `@theme` mappings.
 */
export const tokens = {
  paper: '#F6F1E7',
  surface: '#FFFCF5',
  ink: '#2B2620',
  muted: '#6F6559',
  accent: '#8C5A3B',
  border: '#E3D8C5',
  highlight: '#A8452F',
  fontSerif: '"Noto Serif SC", "Songti SC", "STSong", Georgia, serif',
  fontSans: '"Noto Sans SC", "PingFang SC", "Microsoft YaHei", system-ui, sans-serif',
} as const;

export type Tokens = typeof tokens;
