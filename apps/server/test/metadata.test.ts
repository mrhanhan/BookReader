import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { expect, it } from 'vitest';
import { extractMetadata } from '../src/books/metadata';
import { books, type JobType } from '../src/db/schema';
import type { JobQueue } from '../src/jobs/types';
import { runNextJob } from '../src/jobs/worker';
import {
  buildTestApp,
  buildTestDeps,
  fakeStorage,
  getBookRow,
  resetDb,
  runMetadataJobForTest,
  seedBook,
  seedUser,
  testDb,
} from './helpers';

it('extracts title, author and cover from an EPUB', async () => {
  const result = await extractMetadata({
    buffer: readFileSync('test/fixtures/sample.epub'),
    format: 'epub',
  });
  expect(result.title).toBe('测试之书');
  expect(result.author).toBe('张三');
  expect(result.cover?.contentType).toBe('image/png');
  expect(result.cover!.data.length).toBeGreaterThan(100);
});

it('extracts metadata and renders a cover from a PDF', async () => {
  const result = await extractMetadata({
    buffer: readFileSync('test/fixtures/sample.pdf'),
    format: 'pdf',
  });
  expect(result.title).toBe('PDF 测试');
  expect(result.cover?.contentType).toBe('image/png');
  expect(result.cover!.data.length).toBeGreaterThan(1000);
});

it('marks the metadata job failed without losing the book', async () => {
  await resetDb();
  const app = await buildTestApp();
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id,
    title: '坏文件',
    metadataStatus: 'pending',
  });
  await fakeStorage.putObject(book.fileKey!, Buffer.from('broken'), 'application/pdf');

  await runMetadataJobForTest(book.id);

  const [row] = await testDb.select().from(books).where(eq(books.id, book.id));
  expect(row!.metadataStatus).toBe('failed');
  expect(row!.title).toBe('坏文件');

  await app.close();
});

it('keeps a manually edited title and still stores the extracted cover', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id,
    title: '我的标题',
    originalFilename: '测试之书.epub',
    format: 'epub',
    metadataStatus: 'pending',
  });
  await fakeStorage.putObject(
    book.fileKey!,
    readFileSync('test/fixtures/sample.epub'),
    'application/epub+zip',
  );

  await runMetadataJobForTest(book.id);

  const row = await getBookRow(book.id);
  expect(row!.title).toBe('我的标题');
  expect(row!.author).toBeNull();
  expect(row!.metadataStatus).toBe('done');
  expect(row!.coverKey).toBe(`covers/${book.id}.png`);
  expect(await fakeStorage.head(row!.coverKey!)).not.toBeNull();
});

it('fails a job whose type this worker does not know', async () => {
  const deps = await buildTestDeps();
  const completions: string[] = [];
  const failures: Array<{ id: string; reason: string }> = [];
  const queue: JobQueue = {
    enqueue: async () => undefined,
    claimNext: async () => ({
      id: 'job-unknown',
      type: 'mystery' as JobType,
      payload: {},
      attempts: 0,
      maxAttempts: 3,
    }),
    complete: async (id) => {
      completions.push(id);
    },
    fail: async (id, reason) => {
      failures.push({ id, reason });
    },
  };

  await runNextJob({ ...deps, jobs: queue });

  expect(completions).toEqual([]);
  expect(failures).toEqual([{ id: 'job-unknown', reason: 'Unsupported job type: mystery' }]);
});
