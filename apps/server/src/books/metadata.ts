import type { BookFormat } from '@bookr/shared';
import AdmZip from 'adm-zip';
import { and, eq } from 'drizzle-orm';
import { XMLParser } from 'fast-xml-parser';
import { posix } from 'node:path';
import type { PDFDocumentProxy } from 'pdfjs-dist';
import type { AppDeps } from '../app';
import { books, type NewBook } from '../db/schema';
import { titleFromFilename } from '../uploads/service';

/** A cover image ready to be stored. */
export interface ExtractedCover {
  data: Buffer;
  contentType: 'image/png' | 'image/jpeg';
}

/** Metadata read from the original book file. Every field is optional. */
export interface ExtractedMetadata {
  title?: string;
  author?: string;
  description?: string;
  cover?: ExtractedCover;
}

type XmlRecord = Record<string, unknown>;

const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const JPEG_MAGIC = Buffer.from([0xff, 0xd8, 0xff]);

/** Parsing options that keep attributes addressable and avoid coercing text to numbers. */
const XML_OPTIONS = {
  ignoreAttributes: false,
  attributeNamePrefix: '@_',
  parseTagValue: false,
  trimValues: true,
} as const;

function isRecord(value: unknown): value is XmlRecord {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function asArray(value: unknown): unknown[] {
  if (value === undefined || value === null) {
    return [];
  }
  return Array.isArray(value) ? value : [value];
}

function attribute(node: unknown, name: string): string | undefined {
  if (!isRecord(node)) {
    return undefined;
  }
  const value = node[name];
  return typeof value === 'string' ? value : undefined;
}

/** Extracts trimmed text from a fast-xml-parser node, including attribute-bearing ones. */
function textOf(value: unknown): string | undefined {
  if (typeof value === 'string') {
    const trimmed = value.trim();
    return trimmed || undefined;
  }
  if (Array.isArray(value)) {
    for (const item of value) {
      const text = textOf(item);
      if (text) {
        return text;
      }
    }
    return undefined;
  }
  if (isRecord(value)) {
    return textOf(value['#text']);
  }
  if (typeof value === 'number') {
    return String(value);
  }
  return undefined;
}

/** Collects every text value stored under keys whose local name matches. */
function valuesByLocalName(node: XmlRecord, localName: string): string[] {
  const values: string[] = [];
  for (const [key, value] of Object.entries(node)) {
    const local = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    if (local !== localName) {
      continue;
    }
    for (const item of asArray(value)) {
      const text = textOf(item);
      if (text) {
        values.push(text);
      }
    }
  }
  return values;
}

function joinUnique(values: string[]): string | undefined {
  const unique = [...new Set(values)];
  return unique.length > 0 ? unique.join(', ') : undefined;
}

function coverFromData(data: Buffer): ExtractedCover | undefined {
  if (data.subarray(0, PNG_MAGIC.length).equals(PNG_MAGIC)) {
    return { data, contentType: 'image/png' };
  }
  if (data.subarray(0, JPEG_MAGIC.length).equals(JPEG_MAGIC)) {
    return { data, contentType: 'image/jpeg' };
  }
  return undefined;
}

/** Finds a zip entry, tolerating case and URL-encoding differences in package paths. */
function readZipEntry(zip: AdmZip, entryPath: string): Buffer | undefined {
  const candidates = [entryPath];
  try {
    const decoded = decodeURIComponent(entryPath);
    if (decoded !== entryPath) {
      candidates.push(decoded);
    }
  } catch {
    // A malformed escape simply means there is nothing to decode.
  }

  for (const candidate of candidates) {
    const entry = zip.getEntry(candidate);
    if (entry) {
      return entry.getData();
    }
  }

  const lowerCandidates = new Set(candidates.map((candidate) => candidate.toLowerCase()));
  const match = zip
    .getEntries()
    .find((entry) => lowerCandidates.has(entry.entryName.toLowerCase()));
  return match?.getData();
}

function resolvePackagePath(opfPath: string, href: string): string {
  const withoutFragment = href.split('#')[0] ?? href;
  const base = posix.dirname(opfPath);
  return base === '.' ? withoutFragment : posix.join(base, withoutFragment);
}

function parseXml(xml: string): XmlRecord {
  const parsed = new XMLParser(XML_OPTIONS).parse(xml);
  return isRecord(parsed) ? parsed : {};
}

function findRoot(parsed: XmlRecord, localName: string): XmlRecord | undefined {
  for (const [key, value] of Object.entries(parsed)) {
    const local = key.includes(':') ? key.slice(key.lastIndexOf(':') + 1) : key;
    if (local === localName) {
      return isRecord(value) ? value : undefined;
    }
  }
  return undefined;
}

function findCoverEntry(zip: AdmZip, opfPath: string, opf: XmlRecord): ExtractedCover | undefined {
  const metadata = isRecord(opf.metadata) ? opf.metadata : {};
  const manifest = isRecord(opf.manifest) ? opf.manifest : {};
  const items = asArray(manifest.item).filter(isRecord);

  // The EPUB 3 way: an item explicitly marked as the cover image.
  const byProperty = items.find((item) =>
    (attribute(item, '@_properties') ?? '').split(/\s+/).includes('cover-image'),
  );

  // The EPUB 2 way: <meta name="cover" content="<manifest item id>"/>.
  const coverIds = new Set(
    asArray(metadata.meta)
      .filter(isRecord)
      .filter((meta) => attribute(meta, '@_name') === 'cover')
      .map((meta) => attribute(meta, '@_content'))
      .filter((id): id is string => Boolean(id)),
  );
  const byMeta = items.find((item) => coverIds.has(attribute(item, '@_id') ?? ''));

  const coverItem = byProperty ?? byMeta;
  const href = coverItem ? attribute(coverItem, '@_href') : undefined;
  if (!href) {
    return undefined;
  }

  const data = readZipEntry(zip, resolvePackagePath(opfPath, href));
  return data ? coverFromData(data) : undefined;
}

function extractEpub(buffer: Buffer): ExtractedMetadata {
  const zip = new AdmZip(buffer);

  const containerXml = readZipEntry(zip, 'META-INF/container.xml');
  if (!containerXml) {
    throw new Error('EPUB container.xml is missing');
  }

  const container = findRoot(parseXml(containerXml.toString('utf8')), 'container');
  const rootfiles = container && isRecord(container.rootfiles) ? container.rootfiles : {};
  const rootfile = asArray(rootfiles.rootfile).find(isRecord);
  const opfPath = rootfile ? attribute(rootfile, '@_full-path') : undefined;
  if (!opfPath) {
    throw new Error('EPUB container.xml has no rootfile');
  }

  const opfXml = readZipEntry(zip, opfPath);
  if (!opfXml) {
    throw new Error('EPUB package document is missing');
  }

  const opf = findRoot(parseXml(opfXml.toString('utf8')), 'package');
  if (!opf) {
    throw new Error('EPUB package document has no package element');
  }

  const metadata = isRecord(opf.metadata) ? opf.metadata : {};
  const title = valuesByLocalName(metadata, 'title')[0];
  const author = joinUnique(valuesByLocalName(metadata, 'creator'));
  const description = valuesByLocalName(metadata, 'description')[0];

  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(description ? { description } : {}),
    cover: findCoverEntry(zip, opfPath, opf),
  };
}

/** Renders the first page into a PNG cover using the native canvas backend. */
async function renderPdfCover(document: PDFDocumentProxy): Promise<ExtractedCover | undefined> {
  if (document.numPages < 1) {
    return undefined;
  }

  const { createCanvas } = await import('@napi-rs/canvas');
  const page = await document.getPage(1);
  try {
    const viewport = page.getViewport({ scale: 1.5 });
    const canvas = createCanvas(viewport.width, viewport.height);
    const canvasContext = canvas.getContext('2d');
    await page.render({
      canvasContext,
      viewport,
    } as unknown as Parameters<typeof page.render>[0]).promise;
    return { data: canvas.toBuffer('image/png'), contentType: 'image/png' };
  } finally {
    page.cleanup();
  }
}

async function loadPdf(buffer: Buffer) {
  const pdfjs = await import('pdfjs-dist/legacy/build/pdf.mjs');
  return pdfjs.getDocument({
    data: new Uint8Array(buffer),
    useSystemFonts: true,
    // Suppress PDF.js console output: it may echo document internals.
    verbosity: 0,
  });
}

function extractPdfInfo(info: Record<string, unknown>): ExtractedMetadata {
  const title = textOf(info.Title);
  const author = textOf(info.Author);
  const description = textOf(info.Subject);
  return {
    ...(title ? { title } : {}),
    ...(author ? { author } : {}),
    ...(description ? { description } : {}),
  };
}

async function extractPdf(buffer: Buffer): Promise<ExtractedMetadata> {
  const loadingTask = await loadPdf(buffer);
  try {
    const document = await loadingTask.promise;
    const metadata = await document.getMetadata().catch(() => ({ info: {} }));
    const result = extractPdfInfo(isRecord(metadata.info) ? metadata.info : {});
    const cover = await renderPdfCover(document);
    return cover ? { ...result, cover } : result;
  } finally {
    await loadingTask.destroy().catch(() => undefined);
  }
}

/**
 * Reads embedded metadata and a cover from a book file. Formats without an
 * extractor (MOBI/AZW3) yield an empty result; corrupt files throw.
 */
export async function extractMetadata(input: {
  buffer: Buffer;
  format: BookFormat;
}): Promise<ExtractedMetadata> {
  switch (input.format) {
    case 'epub':
      return extractEpub(input.buffer);
    case 'pdf':
      return extractPdf(input.buffer);
    case 'mobi':
    case 'azw3':
      return {};
  }
}

function hasText(value: string | null): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

/**
 * Applies extracted fields only when the book still has its filename-derived
 * title. Author and description are additionally kept when the user already
 * filled them, so a manual edit is never overwritten.
 */
async function applyExtractedMetadata(
  deps: AppDeps,
  bookId: string,
  extracted: ExtractedMetadata,
  coverKey: string | undefined,
): Promise<void> {
  await deps.db.transaction(async (tx) => {
    const [current] = await tx.select().from(books).where(eq(books.id, bookId)).limit(1).for('update');
    if (!current || current.metadataStatus !== 'pending') {
      return;
    }

    const fields: Partial<NewBook> = {
      metadataStatus: 'done',
      updatedAt: deps.clock.now(),
    };

    if (coverKey && !current.coverKey) {
      fields.coverKey = coverKey;
    }

    if (current.title === titleFromFilename(current.originalFilename)) {
      if (extracted.title) {
        fields.title = extracted.title;
      }
      if (extracted.author && !hasText(current.author)) {
        fields.author = extracted.author;
      }
      if (extracted.description && !hasText(current.description)) {
        fields.description = extracted.description;
      }
    }

    await tx.update(books).set(fields).where(eq(books.id, bookId));
  });
}

/** Records a failed extraction without ever downgrading a finished book. */
async function markMetadataFailed(deps: AppDeps, bookId: string): Promise<void> {
  await deps.db
    .update(books)
    .set({ metadataStatus: 'failed', updatedAt: deps.clock.now() })
    .where(and(eq(books.id, bookId), eq(books.metadataStatus, 'pending')));
}

/** Logs the book id and error class only; parser messages may contain book text. */
function logMetadataFailure(bookId: string, error: unknown): void {
  const errorName = error instanceof Error ? error.name : typeof error;
  console.error(`[metadata] book ${bookId} failed with ${errorName}`);
}

/**
 * Extracts metadata for a pending book, stores its cover under a stable key,
 * and flips `metadata_status` to done or failed. Never throws: a broken file
 * marks the book failed while keeping its row and user-edited fields intact.
 */
export async function runMetadataJob(deps: AppDeps, bookId: string): Promise<void> {
  try {
    const [book] = await deps.db.select().from(books).where(eq(books.id, bookId)).limit(1);
    if (!book || book.metadataStatus !== 'pending') {
      return;
    }
    if (!book.fileKey) {
      throw new Error('Book has no original file key');
    }

    const buffer = await deps.storage.getObject(book.fileKey);
    const extracted = await extractMetadata({ buffer, format: book.format });

    let coverKey: string | undefined;
    if (extracted.cover && !book.coverKey) {
      const extension = extracted.cover.contentType === 'image/png' ? 'png' : 'jpg';
      coverKey = `covers/${bookId}.${extension}`;
      await deps.storage.putObject(coverKey, extracted.cover.data, extracted.cover.contentType);
    }

    await applyExtractedMetadata(deps, bookId, extracted, coverKey);
  } catch (error) {
    await markMetadataFailed(deps, bookId).catch(() => undefined);
    logMetadataFailure(bookId, error);
  }
}
