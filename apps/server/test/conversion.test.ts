import { readFileSync, writeFileSync } from 'node:fs';
import { describe, expect, it } from 'vitest';
import { runConvertJob } from '../src/books/conversion';
import { runNextJob } from '../src/jobs/worker';
import {
  authHeader,
  buildTestApp,
  buildTestDeps,
  enqueuedJobs,
  fakeConverter,
  fakeStorage,
  getBookRow,
  resetDb,
  runMetadataJobForTest,
  seedBook,
  seedUser,
  type SeededUser,
} from './helpers';

/** Writes the fixture EPUB where the converter is expected to leave its output. */
async function writeSampleEpub(_input: unknown, outputPath: string): Promise<void> {
  writeFileSync(outputPath, readFileSync('test/fixtures/sample.epub'));
}

describe('MOBI/AZW3 conversion', () => {
  it('converts MOBI to EPUB and keeps the original file', async () => {
    await resetDb();
    const deps = await buildTestDeps();
    const user = await seedUser('member');
    const book = await seedBook({ uploadedBy: user.id, format: 'mobi', conversionStatus: 'pending' });
    await fakeStorage.putObject(
      book.fileKey!,
      Buffer.from('BOOKMOBI'),
      'application/x-mobipocket-ebook',
    );
    fakeConverter.onConvert = writeSampleEpub;

    await runConvertJob(deps, book.id);

    const converted = await getBookRow(book.id);
    expect(converted!.conversionStatus).toBe('done');
    expect(converted!.conversionError).toBeNull();
    expect(converted!.epubKey).toBe(
      `library/${book.libraryId}/books/${book.id}/converted.epub`,
    );
    expect(fakeStorage.contentTypes.get(converted!.epubKey!)).toBe('application/epub+zip');
    expect(await fakeStorage.head(book.fileKey!)).not.toBeNull();
    expect(enqueuedJobs()).toContainEqual({ type: 'metadata', bookId: book.id });
  });

  it('marks a failed conversion but keeps the original downloadable', async () => {
    await resetDb();
    const deps = await buildTestDeps();
    const user = await seedUser('member');
    const book = await seedBook({ uploadedBy: user.id, format: 'azw3', conversionStatus: 'pending' });
    await fakeStorage.putObject(
      book.fileKey!,
      Buffer.from('BOOKMOBI'),
      'application/vnd.amazon.ebook',
    );
    fakeConverter.onConvert = async () => {
      throw new Error('calibre exploded');
    };

    await runConvertJob(deps, book.id);

    const converted = await getBookRow(book.id);
    expect(converted!.conversionStatus).toBe('failed');
    expect(converted!.conversionError).toMatch(/calibre exploded/);
    expect(converted!.epubKey).toBeNull();
    expect(await fakeStorage.head(book.fileKey!)).not.toBeNull();
  });

  it('dispatches a convert job through the worker', async () => {
    await resetDb();
    const deps = await buildTestDeps();
    const user = await seedUser('member');
    const book = await seedBook({ uploadedBy: user.id, format: 'mobi', conversionStatus: 'pending' });
    await fakeStorage.putObject(
      book.fileKey!,
      Buffer.from('BOOKMOBI'),
      'application/x-mobipocket-ebook',
    );
    fakeConverter.onConvert = writeSampleEpub;
    await deps.jobs.enqueue({ type: 'convert', bookId: book.id });

    expect(await runNextJob(deps)).toBe(true);

    const converted = await getBookRow(book.id);
    expect(converted!.conversionStatus).toBe('done');
    expect(fakeConverter.calls).toHaveLength(1);
    expect(fakeConverter.calls[0]!.input.format).toBe('mobi');
  });

  it('only lets the uploader or an admin retry a failed conversion', async () => {
    await resetDb();
    const app = await buildTestApp();
    const owner = await seedUser('member', 'owner');
    const other = await seedUser('member', 'other');
    const admin = await seedUser('admin', 'admin');
    const book = await seedBook({
      uploadedBy: owner.id,
      format: 'mobi',
      conversionStatus: 'failed',
    });

    const retry = async (user: SeededUser) =>
      app.inject({
        method: 'POST',
        url: `/api/books/${book.id}/convert`,
        headers: await authHeader(user),
      });

    expect((await retry(other)).statusCode).toBe(403);
    expect((await retry(owner)).statusCode).toBe(202);
    expect((await retry(admin)).statusCode).toBe(202);
    expect(enqueuedJobs().filter((job) => job.type === 'convert')).toHaveLength(2);

    await app.close();
  });

  it('rejects a retry while the conversion is not failed', async () => {
    await resetDb();
    const app = await buildTestApp();
    const owner = await seedUser('member', 'owner');
    const book = await seedBook({
      uploadedBy: owner.id,
      format: 'mobi',
      conversionStatus: 'pending',
    });

    const response = await app.inject({
      method: 'POST',
      url: `/api/books/${book.id}/convert`,
      headers: await authHeader(owner),
    });
    expect(response.statusCode).toBe(409);
    expect(enqueuedJobs()).toHaveLength(0);

    await app.close();
  });

  it('extracts metadata and a cover from the converted EPUB of a MOBI book', async () => {
    await resetDb();
    const deps = await buildTestDeps();
    const user = await seedUser('member');
    const book = await seedBook({
      uploadedBy: user.id,
      title: 'book',
      originalFilename: 'book.mobi',
      format: 'mobi',
      metadataStatus: 'done',
      conversionStatus: 'pending',
    });
    await fakeStorage.putObject(
      book.fileKey!,
      Buffer.from('BOOKMOBI'),
      'application/x-mobipocket-ebook',
    );
    fakeConverter.onConvert = writeSampleEpub;

    await runConvertJob(deps, book.id);
    await runMetadataJobForTest(book.id);

    const converted = await getBookRow(book.id);
    expect(converted!.conversionStatus).toBe('done');
    expect(converted!.metadataStatus).toBe('done');
    expect(converted!.title).toBe('测试之书');
    expect(converted!.coverKey).toBe(`covers/${book.id}.png`);
    expect(await fakeStorage.head(converted!.coverKey!)).not.toBeNull();
  });
});
