import type { BookFormat, BookStatus } from '@bookr/shared';
import type { BookSort } from '../../api/books';

export const FORMAT_LABELS: Record<BookFormat, string> = {
  pdf: 'PDF',
  epub: 'EPUB',
  mobi: 'MOBI',
  azw3: 'AZW3',
};

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
