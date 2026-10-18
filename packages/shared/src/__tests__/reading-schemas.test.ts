import { describe, expect, it } from 'vitest';
import {
  MAX_TAGS,
  MAX_TAG_LENGTH,
  createAnnotationSchema, createBookmarkSchema, normalizeTags, updateAnnotationSchema,
  updateBookmarkSchema, updateProgressSchema,
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

  it('requires at least one editable field on an update', () => {
    expect(updateAnnotationSchema.safeParse({ revision: 1 }).success).toBe(false);
  });

  it('normalizes a blank note on a highlight to null', () => {
    expect(createAnnotationSchema.parse({
      color: 'yellow', locator: { kind: 'pdf', page: 1, percent: 0 },
      selectedText: '一段原文', type: 'highlight', noteText: '   ',
    }).noteText).toBeNull();
  });

  it('caps tag count and tag length', () => {
    const base = {
      color: 'yellow', locator: { kind: 'pdf', page: 1, percent: 0 },
      selectedText: '一段原文', type: 'highlight',
    };
    expect(createAnnotationSchema.safeParse({
      ...base, tags: Array.from({ length: MAX_TAGS + 1 }, (_, index) => `tag-${index}`),
    }).success).toBe(false);
    expect(createAnnotationSchema.safeParse({
      ...base, tags: ['x'.repeat(MAX_TAG_LENGTH + 1)],
    }).success).toBe(false);
  });

  it('accepts an empty bookmark label and rejects an over-long one', () => {
    expect(createBookmarkSchema.parse({
      locator: { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', percent: 0.1 }, label: '',
    })).toMatchObject({ label: null });
    expect(createBookmarkSchema.safeParse({
      locator: { kind: 'epub', cfi: 'epubcfi(/6/2!/4)', percent: 0.1 },
      label: 'x'.repeat(201),
    }).success).toBe(false);
    expect(updateBookmarkSchema.parse({ label: '' }).label).toBeNull();
  });
});
