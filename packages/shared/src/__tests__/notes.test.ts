import { describe, expect, it } from 'vitest';
import { MAX_TAG_LENGTH } from '../schemas/reading';
import {
  NOTE_ANALYSIS_KINDS,
  NOTE_ANALYSIS_MAX_NOTES,
  NOTE_ANALYSIS_STATUSES,
  NOTE_ANALYSIS_TITLE_MAX_LENGTH,
  NOTE_DEFAULT_PAGE_SIZE,
  NOTE_EXPORT_MAX_ITEMS,
  NOTE_MAX_PAGE_SIZE,
  NOTE_SEARCH_MAX_LENGTH,
  NOTE_TAG_LIMIT,
  noteAnalysisRequestSchema,
  noteFiltersSchema,
  noteListQuerySchema,
} from '../notes';

function issuePaths(result: ReturnType<typeof noteFiltersSchema.safeParse>): string[] {
  return result.success ? [] : result.error.issues.map((issue) => issue.path.join('.'));
}

describe('notes constants', () => {
  it('locks the cross-package contract values', () => {
    expect(NOTE_DEFAULT_PAGE_SIZE).toBe(30);
    expect(NOTE_MAX_PAGE_SIZE).toBe(100);
    expect(NOTE_TAG_LIMIT).toBe(100);
    expect(NOTE_EXPORT_MAX_ITEMS).toBe(5000);
    expect(NOTE_ANALYSIS_MAX_NOTES).toBe(300);
    expect(NOTE_ANALYSIS_TITLE_MAX_LENGTH).toBe(80);
    expect(NOTE_ANALYSIS_KINDS).toEqual(['themes', 'viewpoints', 'todos']);
    expect(NOTE_ANALYSIS_STATUSES).toEqual(['streaming', 'complete', 'interrupted', 'failed']);
  });
});

describe('notes filter contract', () => {
  it('accepts an empty filter object and trims search text', () => {
    expect(noteFiltersSchema.parse({})).toEqual({});
    expect(noteFiltersSchema.parse({ q: '  张三  ' })).toEqual({ q: '张三' });
  });

  it('rejects an inverted date range', () => {
    const result = noteFiltersSchema.safeParse({ from: '2026-10-19', to: '2026-10-18' });

    expect(result.success).toBe(false);
    if (!result.success) {
      const issue = result.error.issues.find((candidate) => candidate.path[0] === 'to');
      expect(issue?.message).toBe('to must not be before from');
    }
    expect(noteFiltersSchema.safeParse({ from: '2026-10-19', to: '2026-10-19' }).success).toBe(true);
  });

  it('does not add a range issue when a bound is not a real date', () => {
    const result = noteFiltersSchema.safeParse({ from: '2026-13-01', to: '2026-10-19' });

    expect(result.success).toBe(false);
    if (!result.success) {
      // Only the malformed `from` is at fault; `to` stays a valid field.
      expect(result.error.issues.map((issue) => issue.path.join('.'))).toEqual(['from']);
    }
  });

  it('caps the search term at 200 characters', () => {
    expect(NOTE_SEARCH_MAX_LENGTH).toBe(200);
    expect(noteFiltersSchema.safeParse({ q: 'a'.repeat(201) }).success).toBe(false);
    expect(noteFiltersSchema.safeParse({ q: 'a'.repeat(200) }).success).toBe(true);
  });

  it('trims tags, caps their length and requires a UUID book id', () => {
    expect(noteFiltersSchema.parse({ tag: '  方法论 ' })).toEqual({ tag: '方法论' });
    expect(noteFiltersSchema.safeParse({ tag: 'x'.repeat(MAX_TAG_LENGTH + 1) }).success).toBe(false);
    expect(noteFiltersSchema.safeParse({ tag: 'x'.repeat(MAX_TAG_LENGTH) }).success).toBe(true);
    expect(noteFiltersSchema.safeParse({ bookId: 'not-a-uuid' }).success).toBe(false);
    expect(noteFiltersSchema.safeParse({ bookId: '6a1f0d0e-5f0e-4d4a-9b3f-1f2a3b4c5d6e' }).success).toBe(
      true,
    );
  });

  it('validates ISO dates and the annotation type', () => {
    expect(noteFiltersSchema.safeParse({ from: '2026-02-30' }).success).toBe(false);
    expect(noteFiltersSchema.safeParse({ type: 'bookmark' }).success).toBe(false);
    expect(noteFiltersSchema.safeParse({ type: 'note' }).success).toBe(true);
  });
});

describe('notes list query', () => {
  it('defaults list paging and coerces query strings', () => {
    expect(noteListQuerySchema.parse({})).toEqual({
      page: 1,
      pageSize: 30,
    });
    expect(noteListQuerySchema.parse({ page: '2', pageSize: '50' })).toEqual({
      page: 2,
      pageSize: 50,
    });
  });

  it('rejects paging outside the supported range', () => {
    expect(noteListQuerySchema.safeParse({ page: '0' }).success).toBe(false);
    expect(noteListQuerySchema.safeParse({ pageSize: '101' }).success).toBe(false);
    expect(noteListQuerySchema.safeParse({ pageSize: '0' }).success).toBe(false);
    expect(NOTE_MAX_PAGE_SIZE).toBe(100);
  });

  it('applies the same date-range rule as the filter schema', () => {
    expect(noteListQuerySchema.safeParse({ from: '2026-10-19', to: '2026-10-18' }).success).toBe(
      false,
    );
    expect(issuePaths(noteListQuerySchema.safeParse({ from: '2026-10-19', to: '2026-10-18' }))).toContain(
      'to',
    );
  });
});

describe('notes analysis request', () => {
  it('validates analysis requests', () => {
    expect(noteAnalysisRequestSchema.parse({ kind: 'themes' })).toEqual({ kind: 'themes' });
    expect(noteAnalysisRequestSchema.safeParse({ kind: 'unknown' }).success).toBe(false);
    expect(
      noteAnalysisRequestSchema.parse({ kind: 'todos', filters: { tag: '方法论' } }),
    ).toEqual({ kind: 'todos', filters: { tag: '方法论' } });
  });

  it('rejects filters that break the shared rules', () => {
    expect(noteAnalysisRequestSchema.safeParse({ kind: 'viewpoints', filters: { q: 'a'.repeat(201) } }).success).toBe(false);
    expect(
      noteAnalysisRequestSchema.safeParse({
        kind: 'viewpoints',
        filters: { from: '2026-10-19', to: '2026-10-18' },
      }).success,
    ).toBe(false);
  });
});
