import { z } from 'zod';
import { BOOK_FORMATS, BOOK_STATUSES } from '../constants';
import type { CategoryDto } from './categories';

export type BookFormat = (typeof BOOK_FORMATS)[number];
export type BookStatus = (typeof BOOK_STATUSES)[number];

/** State of the mobi/azw3 to epub conversion pipeline. */
export type BookConversionStatus = 'none' | 'pending' | 'done' | 'failed';

const bookFormatSchema = z.enum(BOOK_FORMATS);
const bookStatusSchema = z.enum(BOOK_STATUSES);

export const listBooksQuerySchema = z.object({
  query: z.string().max(100).optional(),
  categoryId: z.uuid().optional(),
  format: bookFormatSchema.optional(),
  status: bookStatusSchema.optional(),
  sort: z.enum(['recent', 'added', 'title']).default('recent'),
  page: z.coerce.number().int().min(1).default(1),
  pageSize: z.coerce.number().int().min(1).max(100).default(24),
});

export const updateBookSchema = z.object({
  title: z.string().min(1).max(200).optional(),
  author: z.string().max(100).nullable().optional(),
  description: z.string().max(2000).nullable().optional(),
  status: bookStatusSchema.optional(),
  categoryIds: z.array(z.uuid()).max(20).optional(),
});

export type ListBooksQuery = z.infer<typeof listBooksQuerySchema>;
export type UpdateBookInput = z.infer<typeof updateBookSchema>;

/** A book as returned by the API. */
export interface BookDto {
  id: string;
  title: string;
  author: string | null;
  description: string | null;
  format: BookFormat;
  size: number;
  coverUrl: string | null;
  status: BookStatus;
  progressPercent: number;
  categories: CategoryDto[];
  uploadedBy: { id: string; displayName: string };
  conversionStatus: BookConversionStatus;
  /** Why the last conversion attempt failed; null unless it failed. */
  conversionError: string | null;
  /** True when a preprocessed reflow pack is stored for this book. */
  reflowAvailable: boolean;
  /** Schema version of the stored pack; null when no pack is stored. */
  reflowSchemaVersion: number | null;
  /** Source page count recorded by the stored pack; null when absent. */
  reflowPageCount: number | null;
  createdAt: string;
  updatedAt: string;
  /** Set when the book was moved to the trash; null while it is on the shelf. */
  deletedAt: string | null;
}
