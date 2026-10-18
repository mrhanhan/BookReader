import { describe, expect, it, vi } from 'vitest';
import { MAX_UPLOAD_BYTES } from '@bookr/shared/constants';
import type { BookDto, PresignedUploadTarget } from '@bookr/shared';
import {
  DuplicateBookError,
  InvalidFileError,
  QuotaExceededError,
  uploadBook,
  type UploadDeps,
} from '../upload';

const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });

const deps = (overrides: Partial<UploadDeps> = {}): UploadDeps => ({
  hash: vi.fn(async () => 'a'.repeat(64)),
  create: vi.fn(async () => ({
    uploadId: 'u1',
    upload: {
      url: 'http://minio/u1',
      fields: { key: 'library/u1/original.pdf', 'Content-Type': 'application/pdf' },
    },
    expiresAt: new Date().toISOString(),
  })),
  post: vi.fn(
    async (_target: PresignedUploadTarget, _file: File, onProgress: (n: number) => void) => {
      onProgress(100);
    },
  ),
  complete: vi.fn(async () => ({ book: { id: 'b1', title: 'a' } as BookDto })),
  ...overrides,
});

it('hashes, uploads and completes in order', async () => {
  const d = deps();
  const progress: number[] = [];
  const book = await uploadBook(file, { ...d, onProgress: (n) => progress.push(n) });
  expect(book.id).toBe('b1');
  expect(d.create).toHaveBeenCalledWith(
    expect.objectContaining({ filename: 'a.pdf', sha256: 'a'.repeat(64) }),
  );
  expect(d.post).toHaveBeenCalled();
  expect(d.complete).toHaveBeenCalledWith('u1');
  expect(progress.at(-1)).toBe(100);
});

it('surfaces duplicate uploads with the existing book id', async () => {
  const d = deps({
    create: vi.fn(async () => {
      throw new DuplicateBookError('existing-1');
    }),
  });
  await expect(uploadBook(file, d)).rejects.toMatchObject({ existingBookId: 'existing-1' });
});

it('surfaces quota errors without calling PUT', async () => {
  const d = deps({
    create: vi.fn(async () => {
      throw new QuotaExceededError();
    }),
  });
  await expect(uploadBook(file, d)).rejects.toBeInstanceOf(QuotaExceededError);
  expect(d.post).not.toHaveBeenCalled();
});

it('rejects oversized files before hashing', async () => {
  const d = deps();
  const huge = {
    name: 'huge.pdf',
    size: MAX_UPLOAD_BYTES + 1,
    type: 'application/pdf',
  } as unknown as File;

  await expect(uploadBook(huge, d)).rejects.toMatchObject({
    name: 'InvalidFileError',
    message: '单本上限 500 MB',
  });
  expect(d.hash).not.toHaveBeenCalled();
});

it('maps API error codes to upload errors', async () => {
  const { ApiError } = await import('../../api/client');
  const d = deps({
    complete: vi.fn(async () => {
      throw new ApiError(409, 'DUPLICATE_BOOK', 'duplicate', { existingBookId: 'book-9' });
    }),
  });

  await expect(uploadBook(file, d)).rejects.toBeInstanceOf(DuplicateBookError);
  await expect(uploadBook(file, d)).rejects.toMatchObject({ existingBookId: 'book-9' });

  const invalid = deps({
    create: vi.fn(async () => {
      throw new ApiError(422, 'INVALID_FILE', 'invalid');
    }),
  });
  await expect(uploadBook(file, invalid)).rejects.toBeInstanceOf(InvalidFileError);
});

it('derives a supported content type when the browser leaves it blank', async () => {
  const d = deps();
  const epub = new File(['PK'], 'book.epub', { type: '' });
  await uploadBook(epub, d);
  expect(d.create).toHaveBeenCalledWith(
    expect.objectContaining({ filename: 'book.epub', contentType: 'application/epub+zip' }),
  );
});

it('rejects unsupported extensions before hashing', async () => {
  const d = deps();
  const txt = new File(['hello'], 'notes.txt', { type: 'text/plain' });
  await expect(uploadBook(txt, d)).rejects.toBeInstanceOf(InvalidFileError);
  expect(d.hash).not.toHaveBeenCalled();
});

describe('upload size guard', () => {
  it('accepts a file exactly at the limit', async () => {
    const d = deps();
    const atLimit = {
      name: 'limit.pdf',
      size: MAX_UPLOAD_BYTES,
      type: 'application/pdf',
    } as unknown as File;
    await expect(uploadBook(atLimit, d)).resolves.toMatchObject({ id: 'b1' });
  });
});
