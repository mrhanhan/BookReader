import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { books, libraries, users } from '../src/db/schema';
import { resetDb, testDb } from './helpers';

it('enforces active-file dedupe per library', async () => {
  await resetDb();
  const [library] = await testDb.insert(libraries).values({ name: '书房' }).returning();
  const [user] = await testDb.insert(users).values({
    username: 'reader', passwordHash: 'x', displayName: '读者', role: 'admin',
  }).returning();
  const base = { libraryId: library!.id, uploadedBy: user!.id, title: 'A', format: 'pdf' as const, originalFilename: 'a.pdf', size: 10, sha256: 'a'.repeat(64) };
  await testDb.insert(books).values(base);
  await expect(testDb.insert(books).values(base)).rejects.toThrow();
});
it('allows the same file again after the first copy is soft-deleted', async () => {
  await resetDb();
  const [library] = await testDb.insert(libraries).values({ name: '书房' }).returning();
  const [user] = await testDb.insert(users).values({ username: 'r2', passwordHash: 'x', displayName: '读者', role: 'member' }).returning();
  const base = { libraryId: library!.id, uploadedBy: user!.id, title: 'A', format: 'pdf' as const, originalFilename: 'a.pdf', size: 10, sha256: 'b'.repeat(64) };
  const [first] = await testDb.insert(books).values(base).returning();
  await testDb.update(books).set({ deletedAt: new Date() }).where(eq(books.id, first!.id));
  await expect(testDb.insert(books).values(base)).resolves.toBeDefined();
});
