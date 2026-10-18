/** Trash retention window; keep in sync with `TRASH_RETENTION_DAYS` in `@bookr/shared`. */
export const TRASH_RETENTION_DAYS = 30;

const BYTE_UNITS = ['B', 'KB', 'MB', 'GB', 'TB'] as const;

/**
 * Formats a byte count for quiet shelf copy, e.g. `28 MB`, `3.5 GB`, `0 B`.
 * Whole numbers keep one decimal only when it adds information.
 */
export function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '0 B';

  let value = bytes;
  let unit = 0;
  while (value >= 1024 && unit < BYTE_UNITS.length - 1) {
    value /= 1024;
    unit += 1;
  }

  if (unit === 0) return `${Math.round(value)} B`;
  const digits = value >= 100 ? 0 : value >= 10 ? 1 : 2;
  const text = value
    .toFixed(digits)
    .replace(/\.0+$/, '')
    .replace(/(\.\d*?)0+$/, '$1');
  return `${text} ${BYTE_UNITS[unit]}`;
}

const dateFormatter = new Intl.DateTimeFormat('zh-CN', {
  year: 'numeric',
  month: 'long',
  day: 'numeric',
});

/** Formats an ISO timestamp as a Chinese calendar date; invalid input is empty. */
export function formatDate(iso: string): string {
  const date = new Date(iso);
  return Number.isNaN(date.getTime()) ? '' : dateFormatter.format(date);
}

/** Whole days left before a trashed book is purged; 0 means cleanup is due. */
export function retentionDaysLeft(deletedAtIso: string, now: Date = new Date()): number {
  const deletedAt = new Date(deletedAtIso).getTime();
  if (Number.isNaN(deletedAt)) return TRASH_RETENTION_DAYS;

  const elapsedDays = Math.max(0, now.getTime() - deletedAt) / (24 * 60 * 60 * 1000);
  return Math.max(0, Math.ceil(TRASH_RETENTION_DAYS - elapsedDays));
}
