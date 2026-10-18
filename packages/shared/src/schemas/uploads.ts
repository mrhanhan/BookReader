import { z } from 'zod';
import { MAX_UPLOAD_BYTES } from '../constants';
import type { BookDto } from './books';

const UPLOAD_CONTENT_TYPES = [
  'application/pdf',
  'application/epub+zip',
  'application/x-mobipocket-ebook',
  'application/vnd.amazon.ebook',
] as const;

export const createUploadSchema = z.object({
  filename: z.string().min(1).max(255),
  size: z.number().int().positive().max(MAX_UPLOAD_BYTES),
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  contentType: z.enum(UPLOAD_CONTENT_TYPES),
});

/** Presigned upload target for a new book file. */
export interface CreateUploadResponse {
  uploadId: string;
  putUrl: string;
  expiresAt: string;
}

/** Result of finalising an upload. */
export interface CompleteUploadResponse {
  book: BookDto;
}
