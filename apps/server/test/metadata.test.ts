import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { expect, it, vi } from 'vitest';
import {
  MAX_COVER_PIXELS,
  MAX_COVER_SIDE_PX,
  MAX_EPUB_COVER_BYTES,
  MAX_EPUB_UNCOMPRESSED_BYTES,
  MAX_EPUB_XML_BYTES,
  assertEntryWithinLimit,
  assertZipWithinLimit,
  extractMetadata,
  planCoverRender,
} from '../src/books/metadata';
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

/** Builds an EPUB with valid metadata whose cover entry declares an oversized length. */
function epubWithOversizedCover(): Buffer {
  const zip = new AdmZip({ noSort: true });
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<?xml version="1.0"?><container><rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    ),
  );
  zip.addFile(
    'OEBPS/content.opf',
    Buffer.from(
      '<?xml version="1.0"?><package>' +
        '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/">' +
        '<dc:title>大封面</dc:title><dc:creator>作者</dc:creator></metadata>' +
        '<manifest><item id="cover" href="cover.png" properties="cover-image"/></manifest>' +
        '</package>',
    ),
  );
  const cover = zip.addFile('OEBPS/cover.png', Buffer.from([0x89, 0x50, 0x4e, 0x47]));
  cover.header.size = MAX_EPUB_COVER_BYTES + 1;
  return zip.toBuffer();
}

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

it('applies extracted metadata when the title is still the filename default', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id,
    title: 'book',
    originalFilename: 'book.epub',
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
  expect(row!.metadataStatus).toBe('done');
  expect(row!.title).toBe('测试之书');
  expect(row!.author).toBe('张三');
  expect(row!.description).toContain('测试');
});

it('keeps parsed metadata when cover extraction fails', async () => {
  await resetDb();
  const user = await seedUser('member');
  const book = await seedBook({
    uploadedBy: user.id,
    title: 'book',
    originalFilename: 'book.epub',
    format: 'epub',
    metadataStatus: 'pending',
  });
  await fakeStorage.putObject(book.fileKey!, epubWithOversizedCover(), 'application/epub+zip');

  const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  const loggedCalls: unknown[][] = [];
  try {
    await runMetadataJobForTest(book.id);
    loggedCalls.push(...errorSpy.mock.calls);
  } finally {
    errorSpy.mockRestore();
  }

  const row = await getBookRow(book.id);
  expect(row!.metadataStatus).toBe('done');
  expect(row!.title).toBe('大封面');
  expect(row!.author).toBe('作者');
  expect(row!.coverKey).toBeNull();

  const logged = loggedCalls.flat().join(' ');
  expect(logged).toContain(book.id);
  expect(logged).toContain('EpubSizeLimitError');
  // Parser details and book text must never reach the log.
  expect(logged).not.toContain('大封面');
});

it('clamps oversized PDF pages before allocating a cover canvas', () => {
  const normal = planCoverRender(595, 842);
  expect(normal.scale).toBe(1.5);
  expect(normal.width).toBe(892);
  expect(normal.height).toBe(1263);

  const huge = planCoverRender(200_000, 120_000);
  expect(huge.width).toBeLessThanOrEqual(MAX_COVER_SIDE_PX);
  expect(huge.height).toBeLessThanOrEqual(MAX_COVER_SIDE_PX);
  expect(huge.width * huge.height).toBeLessThanOrEqual(MAX_COVER_PIXELS);
  expect(huge.width).toBeGreaterThan(0);

  const square = planCoverRender(3_000, 3_000);
  expect(square.width * square.height).toBeLessThanOrEqual(MAX_COVER_PIXELS);
  expect(Math.max(square.width, square.height)).toBeLessThanOrEqual(MAX_COVER_SIDE_PX);
});

it('rejects EPUB archives whose declared sizes exceed the limits', () => {
  const sizedEntry = (size: number) => ({ header: { size } });

  expect(() => assertZipWithinLimit([sizedEntry(MAX_EPUB_UNCOMPRESSED_BYTES)])).not.toThrow();
  expect(() =>
    assertZipWithinLimit([sizedEntry(MAX_EPUB_UNCOMPRESSED_BYTES), sizedEntry(1)]),
  ).toThrow('EPUB uncompressed size exceeds the limit');

  expect(() =>
    assertEntryWithinLimit(sizedEntry(MAX_EPUB_XML_BYTES), MAX_EPUB_XML_BYTES),
  ).not.toThrow();
  expect(() =>
    assertEntryWithinLimit(sizedEntry(MAX_EPUB_XML_BYTES + 1), MAX_EPUB_XML_BYTES),
  ).toThrow('EPUB entry exceeds the size limit');
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
