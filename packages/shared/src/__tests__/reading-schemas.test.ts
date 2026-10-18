import { describe, expect, it } from 'vitest';
import {
  createAnnotationSchema, createBookmarkSchema, normalizeTags, updateAnnotationSchema,
  updateProgressSchema,
} from '../schemas/reading';

describe('reading input schemas', () => {
  it('accepts locator-only progress updates', () => {
    expect(updateProgressSchema.parse({
      locator: { kind: 'pdf', page: 3, percent: 0.12 },
    })).toEqual({ locator: { kind: 'pdf', page: 3, percent: 0.12 } });
  });

  it('requires note text for a note and allows a bare highlight', () => {
    const base = {
      color: 'yellow', locator: { kind: 'pdf', page: 1, percent: 0 },
      selectedText: '一段原文',
    };
    expect(createAnnotationSchema.safeParse({ ...base, type: 'highlight' }).success).toBe(true);
    expect(createAnnotationSchema.safeParse({ ...base, type: 'note', noteText: '   ' }).success).toBe(false);
    expect(createAnnotationSchema.safeParse({ ...base, type: 'note', noteText: '我的想法' }).success).toBe(true);
  });

  it('requires a base revision on updates and normalizes tags', () => {
    expect(updateAnnotationSchema.safeParse({ noteText: '改' }).success).toBe(false);
    expect(updateAnnotationSchema.safeParse({ noteText: '改', revision: 1 }).success).toBe(true);
    expect(normalizeTags(['  历史 ', '历史', '', '军事'])).toEqual(['历史', '军事']);
  });

  it('accepts an empty bookmark label and rejects an over-long one', () => {
    expect(createBookmarkSchema.parse({
      locator: { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', percent: 0.1 }, label: '',
    })).toMatchObject({ label: null });
    expect(createBookmarkSchema.safeParse({
      locator: { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', percent: 0.1 },
      label: 'x'.repeat(201),
    }).success).toBe(false);
  });
});
