import type { BookConversionStatus, BookFormat, BookStatus } from '@bookr/shared';
import type { BookSort } from '../../api/books';

export const FORMAT_LABELS: Record<BookFormat, string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
};

/** Marks a book that has a preprocessed reflow pack on the shelf card. */
export const REFLOW_BADGE_LABEL = '可重排';

export const STATUS_LABELS: Record<BookStatus, string> = {
  unread: '未读',
  reading: '在读',
  finished: '已读完',
};

export const SORT_LABELS: Record<BookSort, string> = {
  recent: '最近更新',
  added: '最近添加',
  title: '按书名',
};

export const CONVERSION_LABELS: Record<BookConversionStatus, string> = {
  none: '无需转换',
  pending: '正在转换为 EPUB',
  done: '已转换为 EPUB',
  failed: '转换失败',
};

/** States the uploader or an admin may retry (a pending job may be stranded). */
export function canRetryConversion(status: BookConversionStatus): boolean {
  return status === 'pending' || status === 'failed';
}
