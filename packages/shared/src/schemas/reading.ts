import { z } from 'zod';
import { locatorSchema, type Locator } from '../locators';

/** Highlight palette shared by the reader UI and the API. */
export const ANNOTATION_COLORS = ['yellow', 'green', 'blue', 'pink', 'purple'] as const;

export type AnnotationColor = (typeof ANNOTATION_COLORS)[number];

const annotationTypeSchema = z.enum(['highlight', 'note']);
const annotationColorSchema = z.enum(ANNOTATION_COLORS);

const MAX_SELECTED_TEXT_LENGTH = 10_000;
const MAX_NOTE_TEXT_LENGTH = 10_000;
/** Maximum number of tags on one annotation; shared with the reader UI. */
export const MAX_TAGS = 20;
/** Maximum length of a single tag; shared with the reader UI. */
export const MAX_TAG_LENGTH = 30;
const MAX_BOOKMARK_LABEL_LENGTH = 200;

/** Trims tags, drops empty ones, dedupes case-sensitively and caps the list at 20. */
export function normalizeTags(tags: string[]): string[] {
  const normalized: string[] = [];
  const seen = new Set<string>();

  for (const rawTag of tags) {
    const tag = rawTag.trim();
    if (tag === '' || seen.has(tag)) {
      continue;
    }
    seen.add(tag);
    normalized.push(tag);
    if (normalized.length === MAX_TAGS) {
      break;
    }
  }

  return normalized;
}

const tagSchema = z.string().trim().min(1).max(MAX_TAG_LENGTH);

/** Tags received by create requests: validated, then normalized for the caller. */
const tagsSchema = z
  .array(tagSchema)
  .max(MAX_TAGS)
  .default([])
  .transform((tags) => normalizeTags(tags));

/** Tags received by update requests: absent means "leave unchanged". */
const optionalTagsSchema = z
  .array(tagSchema)
  .max(MAX_TAGS)
  .transform((tags) => normalizeTags(tags))
  .optional();

/**
 * Optional note text. Blank values are trimmed to an empty string and then collapsed
 * to null so the stored payload never carries an empty note.
 */
const noteTextSchema = z
  .union([
    z.null(),
    z.string().trim().max(MAX_NOTE_TEXT_LENGTH).transform((value) => (value === '' ? null : value)),
  ])
  .optional();

/** Body of a progress save. */
export const updateProgressSchema = z.object({
  locator: locatorSchema,
});

/** Body of an annotation creation request. */
export const createAnnotationSchema = z
  .object({
    type: annotationTypeSchema,
    color: annotationColorSchema,
    locator: locatorSchema,
    selectedText: z.string().trim().min(1).max(MAX_SELECTED_TEXT_LENGTH),
    noteText: noteTextSchema,
    tags: tagsSchema,
  })
  .superRefine((data, ctx) => {
    if (data.type === 'note' && (data.noteText === undefined || data.noteText === null)) {
      ctx.addIssue({ code: 'custom', path: ['noteText'], message: 'noteText is required for a note' });
    }
  });

/**
 * Body of an annotation update. `revision` is the optimistic-lock version the client
 * last saw, so every edit carries it.
 */
export const updateAnnotationSchema = z
  .object({
    revision: z.number().int().min(1),
    color: annotationColorSchema.optional(),
    noteText: noteTextSchema,
    tags: optionalTagsSchema,
  })
  .superRefine((data, ctx) => {
    if (data.color === undefined && data.noteText === undefined && data.tags === undefined) {
      ctx.addIssue({
        code: 'custom',
        message: 'At least one of color, noteText or tags is required',
      });
    }
  });

function normalizeLabel(label: string | null): string | null {
  return label === null || label === '' ? null : label;
}

const bookmarkLabelSchema = z.string().trim().max(MAX_BOOKMARK_LABEL_LENGTH);

/** Body of a bookmark creation request; a blank label becomes null. */
export const createBookmarkSchema = z.object({
  locator: locatorSchema,
  label: bookmarkLabelSchema.nullable().default(null).transform(normalizeLabel),
});

/** Body of a bookmark rename request; an empty label clears it. */
export const updateBookmarkSchema = z.object({
  label: bookmarkLabelSchema.nullable().transform(normalizeLabel),
});

/** Latest reading position for a book. */
export interface ReadingProgressDto {
  bookId: string;
  locator: Locator;
  percent: number;
  updatedAt: string;
}

/** A highlight or note anchored to a locator. */
export interface AnnotationDto {
  id: string;
  bookId: string;
  type: 'highlight' | 'note';
  color: AnnotationColor;
  locator: Locator;
  selectedText: string;
  noteText: string | null;
  tags: string[];
  revision: number;
  createdAt: string;
  updatedAt: string;
}

/** Result of an annotation mutation; conflict is true when the revision was stale. */
export interface AnnotationMutationResult {
  annotation: AnnotationDto;
  conflict: boolean;
}

/** A named reading position. */
export interface BookmarkDto {
  id: string;
  bookId: string;
  locator: Locator;
  label: string | null;
  createdAt: string;
  updatedAt: string;
}
