import AdmZip from 'adm-zip';
import { eq } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PNG } from 'pngjs';
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
import { ProcessMetadataRunner } from '../src/books/metadata-runner';
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

/**
 * Builds an EPUB with valid metadata whose cover entry declares an oversized length.
 */
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

/** Builds a 32x32 gradient PNG comfortably larger than 100 bytes. */
function makeCoverPng(): Buffer {
  const width = 32;
  const height = 32;
  const png = new PNG({ width, height });
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const offset = (width * y + x) * 4;
      png.data[offset] = Math.round((x / (width - 1)) * 255);
      png.data[offset + 1] = Math.round((y / (height - 1)) * 255);
      png.data[offset + 2] = 160;
      png.data[offset + 3] = 255;
    }
  }
  return PNG.sync.write(png);
}

/** Builds an EPUB whose package document is `opf` plus extra OEBPS-relative files. */
function buildEpub(opf: string, files: Record<string, Buffer> = {}): Buffer {
  const zip = new AdmZip({ noSort: true });
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  zip.addFile(
    'META-INF/container.xml',
    Buffer.from(
      '<?xml version="1.0"?><container><rootfiles>' +
        '<rootfile full-path="OEBPS/content.opf"/></rootfiles></container>',
    ),
  );
  zip.addFile('OEBPS/content.opf', Buffer.from(opf));
  for (const [path, data] of Object.entries(files)) {
    zip.addFile(`OEBPS/${path}`, data);
  }
  return zip.toBuffer();
}

/** Wraps a package document body in the minimal `<package>` element. */
function packageXml(body: string): string {
  return `<?xml version="1.0"?><package>${body}</package>`;
}

/** Builds a three-page PDF whose first page is blank. */
async function pdfWithBlankFirstPage(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.addPage([595, 842]);

  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  const second = pdf.addPage([595, 842]);
  second.drawRectangle({ x: 72, y: 600, width: 451, height: 120, color: rgb(0, 0, 0) });
  second.drawText('Cover page', { x: 72, y: 760, size: 28, font, color: rgb(0, 0, 0) });

  const third = pdf.addPage([595, 842]);
  third.drawRectangle({ x: 72, y: 600, width: 451, height: 120, color: rgb(0.9, 0.1, 0.1) });

  return Buffer.from(await pdf.save());
}

/**
 * Builds an EPUB whose container.xml declares 64 uncompressed bytes but
 * actually inflates to 24 MiB. Central-directory sizes cannot be trusted, so
 * the reader must cap the byte stream rather than the header.
 */
function epubWithLyingContainer(): Buffer {
  const zip = new AdmZip({ noSort: true });
  zip.addFile('mimetype', Buffer.from('application/epub+zip'));
  const container = zip.addFile(
    'META-INF/container.xml',
    Buffer.alloc(24 * 1024 * 1024, 0x78),
  );
  container.header.size = 64;
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

it('skips a blank first PDF page when rendering the cover', async () => {
  const result = await extractMetadata({
    buffer: await pdfWithBlankFirstPage(),
    format: 'pdf',
  });

  expect(result.cover?.contentType).toBe('image/png');
  const png = PNG.sync.read(result.cover!.data);
  let nonWhite = 0;
  for (let index = 0; index < png.data.length; index += 4) {
    const alpha = png.data[index + 3] ?? 0;
    if (alpha === 0) {
      continue;
    }
    const red = png.data[index] ?? 0;
    const green = png.data[index + 1] ?? 0;
    const blue = png.data[index + 2] ?? 0;
    if (red < 250 || green < 250 || blue < 250) {
      nonWhite += 1;
    }
  }
  // Covering page 2's black rectangle means the cover cannot be all white.
  expect(nonWhite / (png.width * png.height)).toBeGreaterThan(0.001);
});

it('extracts an EPUB cover referenced only by the guide', async () => {
  const opf = packageXml(
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Guide Cover</dc:title></metadata>' +
      '<manifest>' +
      '<item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>' +
      '</manifest>' +
      '<spine><itemref idref="cover-page"/></spine>' +
      '<guide><reference type="cover" href="Text/cover.xhtml"/></guide>',
  );
  const epub = buildEpub(opf, {
    'Text/cover.xhtml': Buffer.from(
      '<?xml version="1.0"?><html xmlns="http://www.w3.org/1999/xhtml">' +
        '<body><img src="../Images/cover.png" alt="cover"/></body></html>',
    ),
    'Images/cover.png': makeCoverPng(),
  });

  const result = await extractMetadata({ buffer: epub, format: 'epub' });

  expect(result.title).toBe('Guide Cover');
  expect(result.cover?.contentType).toBe('image/png');
  expect(result.cover!.data.length).toBeGreaterThan(100);
});

it('extracts an EPUB cover from a manifest filename heuristic', async () => {
  const opf = packageXml(
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Filename Cover</dc:title></metadata>' +
      '<manifest>' +
      '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>' +
      '</manifest>',
  );
  const jpeg = Buffer.concat([
    Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
    Buffer.alloc(256, 0x20),
  ]);
  const epub = buildEpub(opf, { 'images/cover.jpg': jpeg });

  const result = await extractMetadata({ buffer: epub, format: 'epub' });

  expect(result.cover?.contentType).toBe('image/jpeg');
  expect(result.cover!.data.length).toBeGreaterThan(100);
});

it('falls through a broken guide image to a filename cover', async () => {
  const opf = packageXml(
    '<metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Broken Guide</dc:title></metadata>' +
      '<manifest>' +
      '<item id="cover-page" href="Text/cover.xhtml" media-type="application/xhtml+xml"/>' +
      '<item id="cover-img" href="images/cover.jpg" media-type="image/jpeg"/>' +
      '</manifest>' +
      '<guide><reference type="cover" href="Text/cover.xhtml"/></guide>',
  );
  const epub = buildEpub(opf, {
    'Text/cover.xhtml': Buffer.from(
      '<?xml version="1.0"?><html><body><img src="../Images/missing.png"/></body></html>',
    ),
    'images/cover.jpg': Buffer.concat([
      Buffer.from([0xff, 0xd8, 0xff, 0xe0]),
      Buffer.alloc(256, 0x20),
    ]),
  });

  const result = await extractMetadata({ buffer: epub, format: 'epub' });

  expect(result.cover?.contentType).toBe('image/jpeg');
});

it('rejects an EPUB entry that inflates past its declared size', async () => {
  // The header claims 64 bytes, so the central-directory pre-check passes; the
  // streaming reader must stop as soon as the actual output exceeds that.
  await expect(
    extractMetadata({ buffer: epubWithLyingContainer(), format: 'epub' }),
  ).rejects.toThrow(/too many bytes|size limit/i);
});

it('runs EPUB parsing in an isolated process', async () => {
  const runner = new ProcessMetadataRunner({ timeoutMs: 60_000 });
  const result = await runner.extract({
    buffer: readFileSync('test/fixtures/sample.epub'),
    format: 'epub',
  });
  expect(result.title).toBe('测试之书');
  expect(result.author).toBe('张三');
  expect(result.cover?.contentType).toBe('image/png');
  expect(result.cover!.data.length).toBeGreaterThan(100);
}, 60_000);

it('fails the isolated process instead of buffering an over-limit entry', async () => {
  const runner = new ProcessMetadataRunner({ timeoutMs: 60_000 });
  await expect(
    runner.extract({ buffer: epubWithLyingContainer(), format: 'epub' }),
  ).rejects.toMatchObject({ name: 'MetadataProcessError' });
}, 60_000);

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
