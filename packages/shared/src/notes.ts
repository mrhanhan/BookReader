import { z } from 'zod';
import type { AiQuotaWindowDto } from './ai';
import type { Locator } from './locators';
import type { BookFormat } from './schemas/books';
import { MAX_TAG_LENGTH, type AnnotationColor } from './schemas/reading';

/** Maximum length of the free-text search term accepted by the notes API. */
export const NOTE_SEARCH_MAX_LENGTH = 200;
/** Page size used when a list query does not ask for one. */
export const NOTE_DEFAULT_PAGE_SIZE = 30;
/** Hard limit on the page size of a notes list response. */
export const NOTE_MAX_PAGE_SIZE = 100;
/** Maximum number of distinct tags returned by the tag cloud. */
export const NOTE_TAG_LIMIT = 100;
/** Maximum number of notes one export may contain. */
export const NOTE_EXPORT_MAX_ITEMS = 5_000;
/** Maximum number of notes one AI analysis may read. */
export const NOTE_ANALYSIS_MAX_NOTES = 300;
/** Maximum length of the generated analysis title. */
export const NOTE_ANALYSIS_TITLE_MAX_LENGTH = 80;

export const NOTE_ANALYSIS_KINDS = ['themes', 'viewpoints', 'todos'] as const;
export type NoteAnalysisKind = (typeof NOTE_ANALYSIS_KINDS)[number];
export const NOTE_ANALYSIS_STATUSES = ['streaming', 'complete', 'interrupted', 'failed'] as const;
export type NoteAnalysisStatus = (typeof NOTE_ANALYSIS_STATUSES)[number];

/** Shared by GET /api/notes, /api/notes/export and POST /api/notes/analyses. */
export interface NoteFilters {
  q?: string;
  bookId?: string;
  tag?: string;
  type?: 'highlight' | 'note';
  from?: string; // YYYY-MM-DD, inclusive, interpreted in the user's timezone
  to?: string;   // YYYY-MM-DD, inclusive
}

/** Fields shared by every schema that accepts note filters. */
const noteFilterFields = {
  q: z.string().trim().max(NOTE_SEARCH_MAX_LENGTH).optional(),
  bookId: z.uuid().optional(),
  tag: z.string().trim().max(MAX_TAG_LENGTH).optional(),
  type: z.enum(['highlight', 'note']).optional(),
  from: z.iso.date().optional(),
  to: z.iso.date().optional(),
};

/** True only for a real calendar date in `YYYY-MM-DD` form (2026-02-30 fails). */
function isIsoDate(value: string): boolean {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);
  if (!match) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const date = new Date(Date.UTC(year, month - 1, day));
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function checkDateRange(filters: { from?: string; to?: string }, ctx: z.RefinementCtx): void {
  const { from, to } = filters;
  // A malformed bound already fails its own field validation; comparing the
  // raw strings here would additionally flag a valid `to` as out of range.
  if (from === undefined || to === undefined) return;
  if (!isIsoDate(from) || !isIsoDate(to)) return;
  if (from > to) {
    ctx.addIssue({ code: 'custom', path: ['to'], message: 'to must not be before from' });
  }
}

export const noteFiltersSchema: z.ZodType<NoteFilters> = z
  .object(noteFilterFields)
  .superRefine(checkDateRange);

export type NoteListQuery = NoteFilters & { page: number; pageSize: number };

export const noteListQuerySchema: z.ZodType<NoteListQuery> = z
  .object({
    ...noteFilterFields,
    page: z.coerce.number().int().min(1).default(1),
    pageSize: z.coerce
      .number()
      .int()
      .min(1)
      .max(NOTE_MAX_PAGE_SIZE)
      .default(NOTE_DEFAULT_PAGE_SIZE),
  })
  .superRefine(checkDateRange);

export const noteAnalysisRequestSchema: z.ZodType<{
  kind: NoteAnalysisKind;
  filters?: NoteFilters;
}> = z.object({
  kind: z.enum(NOTE_ANALYSIS_KINDS),
  filters: noteFiltersSchema.optional(),
});

export interface NoteBookRef {
  id: string;
  title: string;
  author: string | null;
  format: BookFormat;
}

export interface NoteDto {
  id: string;
  book: NoteBookRef;
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

export interface NoteListResponse {
  items: NoteDto[];
  total: number;
  page: number;
  pageSize: number;
}

export interface NoteTagCount {
  tag: string;
  count: number;
}

export interface NoteAnalysisSummaryDto {
  id: string;
  kind: NoteAnalysisKind;
  status: NoteAnalysisStatus;
  title: string;
  noteCount: number;
  analyzedCount: number;
  createdAt: string;
  updatedAt: string;
}

export interface NoteAnalysisDto extends NoteAnalysisSummaryDto {
  content: string;
  model: string | null;
  promptVersion: string | null;
  scope: NoteFilters;
}

export interface NoteAnalysisStreamMeta {
  analysisId: string;
  kind: NoteAnalysisKind;
  model: string;
  promptVersion: string;
  noteCount: number;
  analyzedCount: number;
}

export interface NoteAnalysisStreamDone {
  analysisId: string;
  usage: { promptTokens: number; completionTokens: number };
  quota: { daily: AiQuotaWindowDto; monthly: AiQuotaWindowDto };
}

export const NOTE_ANALYSIS_STREAM_EVENTS = ['meta', 'delta', 'done', 'error'] as const;
