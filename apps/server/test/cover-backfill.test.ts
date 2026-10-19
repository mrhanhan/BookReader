import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { backfillMissingCovers } from '../src/books/cover-backfill';
import {
  buildTestDeps,
  fakeStorage,
  getBookRow,
  resetDb,
  seedBook,
  seedUser,
} from './helpers';

/** Stores the EPUB fixture under a book's file key. */
async function putEpub(fileKey: string): Promise<void> {
  await fakeStorage.putObject(
    fileKey,
    readFileSync('test/fixtures/sample.epub'),
    'application/epub+zip',
  );
}

it('extracts and stores covers for live books without one', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id,
    format: 'epub',
    originalFilename: 'sample.epub',
  });
  await putEpub(book.fileKey!);

  const result = await backfillMissingCovers(deps);

  expect(result.scanned).toBe(1);
  expect(result.updated).toBe(1);
  expect(result.failed).toBe(0);

  const row = await getBookRow(book.id);
  expect(row!.coverKey).toBe(`covers/${book.id}.png`);
  expect(await fakeStorage.head(row!.coverKey!)).not.toBeNull();
});

it('leaves books that already have a cover untouched', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const uncovered = await seedBook({
    uploadedBy: user.id,
    format: 'epub',
    originalFilename: 'sample.epub',
  });
  await putEpub(uncovered.fileKey!);
  const covered = await seedBook({
    uploadedBy: user.id,
    format: 'epub',
    originalFilename: 'covered.epub',
    coverKey: 'covers/existing.png',
  });
  await putEpub(covered.fileKey!);

  const result = await backfillMissingCovers(deps);

  expect(result.scanned).toBe(1);
  expect(result.updated).toBe(1);
  expect((await getBookRow(covered.id))!.coverKey).toBe('covers/existing.png');
});

it('ignores trashed books without a cover', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const trashed = await seedBook({
    uploadedBy: user.id,
    format: 'epub',
    originalFilename: 'trashed.epub',
    deletedAt: new Date(),
  });
  await putEpub(trashed.fileKey!);

  const result = await backfillMissingCovers(deps);

  expect(result.scanned).toBe(0);
  expect(result.updated).toBe(0);
  expect(result.failed).toBe(0);
  expect((await getBookRow(trashed.id))!.coverKey).toBeNull();
});

it('honours the limit option', async () => {
  await resetDb();
  const deps = await buildTestDeps();
  const user = await seedUser('member');
  const first = await seedBook({
    uploadedBy: user.id,
    format: 'epub',
    originalFilename: 'first.epub',
    createdAt: new Date('2024-01-01T00:00:00Z'),
  });
  await putEpub(first.fileKey!);
  const second = await seedBook({
    uploadedBy: user.id,
    format: 'epub',
    originalFilename: 'second.epub',
    createdAt: new Date('2024-01-02T00:00:00Z'),
  });
  await putEpub(second.fileKey!);

  const result = await backfillMissingCovers(deps, { limit: 1 });

  expect(result.scanned).toBe(1);
  expect(result.updated).toBe(1);
  expect((await getBookRow(first.id))!.coverKey).toBe(`covers/${first.id}.png`);
  expect((await getBookRow(second.id))!.coverKey).toBeNull();
});
