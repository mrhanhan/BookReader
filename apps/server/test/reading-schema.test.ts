import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { annotations, bookmarks, readingProgress } from '../src/db/schema';
import {
  resetDb,
  seedAnnotation,
  seedBook,
  seedBookmark,
  seedProgress,
  seedUser,
  testDb,
} from './helpers';

it('stores per-user progress, annotations and bookmarks', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedProgress({ userId: user.id, bookId: book.id, percent: 0.42, page: 12 });
  await seedAnnotation({ userId: user.id, bookId: book.id, noteText: '想法' });
  await seedBookmark({ userId: user.id, bookId: book.id, label: '此处' });

  expect((await testDb.select().from(readingProgress)).length).toBe(1);
  expect((await testDb.select().from(annotations)).length).toBe(1);
  expect((await testDb.select().from(bookmarks)).length).toBe(1);
});

it('allows one progress row per user and book', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  await seedProgress({ userId: user.id, bookId: book.id, percent: 0.1 });
  await seedProgress({ userId: user.id, bookId: book.id, percent: 0.7 });
  const rows = await testDb
    .select()
    .from(readingProgress)
    .where(eq(readingProgress.bookId, book.id));
  expect(rows).toHaveLength(1);
  expect(rows[0]?.percent).toBe(0.7);
});
