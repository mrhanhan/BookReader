import { ERROR_CODES, type BookFormat } from '@bookr/shared';
import { and, eq, ne } from 'drizzle-orm';
import { spawn } from 'node:child_process';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AppDeps } from '../app';
import { auditLogs, books } from '../db/schema';
import { AppError } from '../errors';
import { findBookById } from './repo';
import { canManage, type BookActor } from './service';

/** Formats Calibre can turn into an EPUB. */
const CONVERTIBLE_FORMATS: ReadonlySet<BookFormat> = new Set(['mobi', 'azw3']);

/** Content type of a converted book. */
const EPUB_CONTENT_TYPE = 'application/epub+zip';

/** A conversion is abandoned (and the child killed) after ten minutes. */
export const CONVERSION_TIMEOUT_MS = 10 * 60 * 1000;

/** Input handed to a converter; `format` exists only for logging and diagnostics. */
export interface ConverterInput {
  path: string;
  format: BookFormat;
}

/**
 * Turns a book file into an EPUB. Implementations must reject with a message
 * that never contains book text, because the message is shown to the user.
 */
export interface Converter {
  convert(input: ConverterInput, outputPath: string): Promise<void>;
}

/** Raised by `CalibreConverter`; the message is fixed so no output leaks. */
class ConversionProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConversionProcessError';
  }
}

/**
 * Runs the Calibre CLI (`ebook-convert`) as a child process. The book's text
 * never reaches stdout in this process: stdio is ignored, and failures are
 * reported with fixed messages instead of the CLI output.
 */
export class CalibreConverter implements Converter {
  constructor(private readonly command: string = 'ebook-convert') {}

  async convert(input: ConverterInput, outputPath: string): Promise<void> {
    await new Promise<void>((resolve, reject) => {
      const child = spawn(this.command, [input.path, outputPath], { stdio: 'ignore' });
      let settled = false;

      const settle = (error?: Error): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve();
        }
      };

      const timer = setTimeout(() => {
        if (settled) {
          return;
        }
        settled = true;
        child.kill('SIGKILL');
        reject(new ConversionProcessError('Conversion timed out'));
      }, CONVERSION_TIMEOUT_MS);
      timer.unref?.();

      child.once('error', () => {
        settle(new ConversionProcessError('Conversion process could not be started'));
      });
      child.once('close', (code, signal) => {
        if (code === 0) {
          settle();
          return;
        }
        const reason = code !== null ? `code ${code}` : `signal ${signal ?? 'unknown'}`;
        settle(new ConversionProcessError(`Conversion process exited with ${reason}`));
      });
    });
  }
}

/** One recorded `FakeConverter` invocation. */
export interface FakeConvertCall {
  input: ConverterInput;
  outputPath: string;
}

async function unconfiguredConvert(): Promise<void> {
  throw new Error('FakeConverter.onConvert is not configured');
}

/** In-memory converter used by tests; the test supplies the output file. */
export class FakeConverter implements Converter {
  readonly calls: FakeConvertCall[] = [];
  onConvert: (input: ConverterInput, outputPath: string) => Promise<void> = unconfiguredConvert;

  async convert(input: ConverterInput, outputPath: string): Promise<void> {
    this.calls.push({ input, outputPath });
    await this.onConvert(input, outputPath);
  }

  reset(): void {
    this.calls.length = 0;
    this.onConvert = unconfiguredConvert;
  }
}

/** Stable key of the EPUB generated from a MOBI/AZW3 original. */
export function convertedEpubKey(book: { id: string; libraryId: string }): string {
  return `library/${book.libraryId}/books/${book.id}/converted.epub`;
}

/** Records the outcome without ever storing converter output or book text. */
async function recordConversionAudit(
  deps: AppDeps,
  bookId: string,
  status: 'done' | 'failed',
): Promise<void> {
  await deps.db
    .insert(auditLogs)
    .values({ userId: null, action: 'book.convert', target: bookId, metadata: { status } })
    .catch(() => undefined);
}

/**
 * Converts one MOBI/AZW3 book to EPUB in a private temporary directory. The
 * original object is only ever read. A failure is recorded on the row so the
 * UI can show it and the uploader can retry; the job itself still completes.
 */
export async function runConvertJob(deps: AppDeps, bookId: string): Promise<void> {
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book || !CONVERTIBLE_FORMATS.has(book.format) || book.conversionStatus === 'done') {
    return;
  }

  const tempDir = await mkdtemp(join(tmpdir(), 'bookr-convert-'));
  try {
    if (!book.fileKey) {
      throw new Error('Book has no original file key');
    }

    const inputPath = join(tempDir, `original.${book.format}`);
    await writeFile(inputPath, await deps.storage.getObject(book.fileKey));

    const outputPath = join(tempDir, 'converted.epub');
    await deps.converter.convert({ path: inputPath, format: book.format }, outputPath);

    const epub = await readFile(outputPath);
    if (epub.length === 0) {
      throw new Error('Converter produced an empty file');
    }

    const epubKey = convertedEpubKey(book);
    await deps.storage.putObject(epubKey, epub, EPUB_CONTENT_TYPE);
    const now = deps.clock.now();

    // The converted EPUB becomes the metadata source, so extraction runs again
    // with an EPUB parser even though the book itself stays a MOBI/AZW3 row.
    await deps.db
      .update(books)
      .set({
        epubKey,
        conversionStatus: 'done',
        conversionError: null,
        metadataStatus: 'pending',
        updatedAt: now,
      })
      .where(eq(books.id, book.id));

    await deps.jobs.enqueue({ type: 'metadata', bookId: book.id });
    await recordConversionAudit(deps, book.id, 'done');
  } catch (error) {
    const message = error instanceof Error ? error.message : 'Conversion failed';
    // A retry that lost a race with a successful worker must not downgrade it.
    await deps.db
      .update(books)
      .set({ conversionStatus: 'failed', conversionError: message, updatedAt: deps.clock.now() })
      .where(and(eq(books.id, book.id), ne(books.conversionStatus, 'done')));
    await recordConversionAudit(deps, book.id, 'failed');
  } finally {
    // Temporary inputs may contain book text; always remove them.
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

/**
 * Queues a retry for a failed conversion. Only the uploader or an admin may
 * ask; any other state is a conflict because there is nothing to retry.
 */
export async function retryConversion(
  deps: AppDeps,
  actor: BookActor,
  bookId: string,
): Promise<void> {
  const book = await findBookById(deps.db, bookId, { includeDeleted: false });
  if (!book) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  if (!canManage(actor, book)) {
    throw new AppError(403, ERROR_CODES.FORBIDDEN);
  }
  if (book.conversionStatus !== 'failed') {
    throw new AppError(409, ERROR_CODES.CONFLICT);
  }
  await deps.jobs.enqueue({ type: 'convert', bookId: book.id });
}
