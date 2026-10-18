import { describe, expect, it } from 'vitest';
import { registerSchema } from '../schemas/auth';
import { createUploadSchema } from '../schemas/uploads';
import { listBooksQuerySchema } from '../schemas/books';

it('rejects passwords shorter than 10 characters', () => {
  const result = registerSchema.safeParse({ inviteCode: 'ABC123', username: 'reader', password: 'short', displayName: '读者' });
  expect(result.success).toBe(false);
});
it('rejects files over 500 MiB and malformed sha256', () => {
  const base = { filename: 'a.pdf', contentType: 'application/pdf', sha256: 'a'.repeat(64) };
  expect(createUploadSchema.safeParse({ ...base, size: 524288001 }).success).toBe(false);
  expect(createUploadSchema.safeParse({ ...base, size: 1024, sha256: 'xyz' }).success).toBe(false);
  expect(createUploadSchema.safeParse({ ...base, size: 1024 }).success).toBe(true);
});
it('defaults book list pagination to 24 and caps it at 100', () => {
  expect(listBooksQuerySchema.parse({}).pageSize).toBe(24);
  expect(listBooksQuerySchema.safeParse({ pageSize: 101 }).success).toBe(false);
});
