import { describe, expect, it } from 'vitest';
import {
  BOOK_FORMATS, BOOK_STATUSES, LIBRARY_QUOTA_BYTES,
  MAX_UPLOAD_BYTES, MEMBER_UPLOAD_QUOTA_BYTES, TRASH_RETENTION_DAYS,
} from '../constants';

describe('shared constants', () => {
  it('pins the supported book formats', () => {
    expect(BOOK_FORMATS).toEqual(['pdf', 'epub', 'mobi', 'azw3']);
  });
  it('pins statuses, upload limit, quotas and retention', () => {
    expect(BOOK_STATUSES).toEqual(['unread', 'reading', 'finished']);
    expect(MAX_UPLOAD_BYTES).toBe(500 * 1024 * 1024);
    expect(LIBRARY_QUOTA_BYTES).toBe(80 * 1024 ** 3);
    expect(MEMBER_UPLOAD_QUOTA_BYTES).toBe(20 * 1024 ** 3);
    expect(TRASH_RETENTION_DAYS).toBe(30);
  });
});
