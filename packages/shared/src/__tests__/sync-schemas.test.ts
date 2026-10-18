import { describe, expect, it } from 'vitest';
import {
  SYNC_PUSH_MAX_CHANGES,
  syncAnnotationPayloadSchema,
  syncKey,
  syncProgressPayloadSchema,
  syncPullQuerySchema,
  syncPushRequestSchema,
  syncSettingsPayloadSchema,
} from '../sync';

const BOOK = '01a14f19-c2e6-73c7-a934-733f788451cf';
const ISO = '2026-10-18T08:00:00.000Z';
const change = (over: Record<string, unknown> = {}) => ({
  entityType: 'reading_progress',
  entityId: BOOK,
  op: 'upsert',
  clientUpdatedAt: ISO,
  payload: { bookId: BOOK, locator: { kind: 'pdf', page: 12, percent: 0.4 } },
  ...over,
});

describe('sync contract', () => {
  it('builds stable keys', () => {
    expect(syncKey('annotation', 'abc')).toBe('annotation:abc');
  });
  it('accepts a well-formed push request', () => {
    expect(syncPushRequestSchema.safeParse({ changes: [change()] }).success).toBe(true);
  });
  it('rejects more than the batch limit', () => {
    const changes = Array.from({ length: SYNC_PUSH_MAX_CHANGES + 1 }, () => change());
    expect(syncPushRequestSchema.safeParse({ changes }).success).toBe(false);
  });
  it('rejects non-UTC client times', () => {
    expect(syncPushRequestSchema.safeParse({
      changes: [change({ clientUpdatedAt: '2026-10-18T08:00:00.000+00:00' })],
    }).success).toBe(false);
  });
  it('validates the progress locator kind', () => {
    expect(syncProgressPayloadSchema.safeParse({ bookId: BOOK, locator: { kind: 'nope' } }).success).toBe(false);
  });
  it('requires a note body for note annotations', () => {
    const base = { bookId: BOOK, color: 'yellow', locator: { kind: 'pdf', page: 1, percent: 0 }, selectedText: 'x', tags: [] };
    expect(syncAnnotationPayloadSchema.safeParse({ ...base, type: 'note', noteText: null }).success).toBe(false);
    expect(syncAnnotationPayloadSchema.safeParse({ ...base, type: 'highlight', noteText: null }).success).toBe(true);
  });
  it('caps settings payloads at 16 KiB', () => {
    expect(syncSettingsPayloadSchema.safeParse({ settings: { big: 'x'.repeat(17000) } }).success).toBe(false);
  });
  it('defaults and clamps the pull query', () => {
    expect(syncPullQuerySchema.parse({})).toEqual({ since: 0, limit: 200 });
    expect(syncPullQuerySchema.safeParse({ limit: 501 }).success).toBe(false);
  });
});
