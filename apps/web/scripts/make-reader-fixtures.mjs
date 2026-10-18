/**
 * Generates the deterministic fixtures the reader acceptance tests upload.
 *
 *   e2e/fixtures/reader.pdf         - 300 US-Letter pages with selectable text
 *   e2e/fixtures/reader.epub        - minimal EPUB 3 with two chapters
 *   e2e/fixtures/reader.bookr.json  - reflow pack for reader.pdf
 *
 * All files are git-ignored and rebuilt by `e2e/global-setup.ts` before each
 * Playwright run, so they are never stale. Metadata dates are pinned and the
 * zip entries are written in a fixed order, making byte-for-byte output stable
 * (the library's sha256 dedupe depends on it). The reflow pack hashes the PDF
 * bytes exactly as written to disk, so it always matches the uploaded book.
 */
import { createHash } from 'node:crypto';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { PDFDocument, StandardFonts } from 'pdf-lib';

const scriptDir = dirname(fileURLToPath(import.meta.url));
const fixturesDir = join(scriptDir, '..', 'e2e', 'fixtures');

const PAGE_COUNT = 300;
const US_LETTER = [612, 792];
const FIXED_DATE = new Date('2024-01-01T00:00:00Z');

const EPUB_TITLE = 'Bookr Reader Fixture';
const EPUB_IDENTIFIER = 'urn:uuid:6b1e5f5c-4c3a-4f8e-9c2d-1a2b3c4d5e6f';

async function makePdf() {
  const pdf = await PDFDocument.create();
  // pdf-lib stamps the current time into Info on create; pin both dates so the
  // fixture hash is stable.
  pdf.setTitle('Bookr Reader Fixture');
  pdf.setAuthor('Bookr fixtures');
  pdf.setCreator('Bookr fixtures');
  pdf.setProducer('Bookr fixtures');
  pdf.setCreationDate(FIXED_DATE);
  pdf.setModificationDate(FIXED_DATE);

  const font = await pdf.embedFont(StandardFonts.Helvetica);

  for (let pageNumber = 1; pageNumber <= PAGE_COUNT; pageNumber += 1) {
    const page = pdf.addPage(US_LETTER);
    page.drawText(`Bookr reader fixture - page ${pageNumber}`, {
      x: 72,
      y: 720,
      size: 18,
      font,
    });
    if (pageNumber === 1) {
      page.drawText('The quick brown fox jumps over the lazy dog', {
        x: 72,
        y: 680,
        size: 16,
        font,
      });
    }
    if (pageNumber === 3) {
      page.drawText('reader fixture page three', {
        x: 72,
        y: 680,
        size: 16,
        font,
      });
    }
  }

  return Buffer.from(await pdf.save());
}

/** Long enough that epub.js' 1600-character location map has several entries. */
const FILLER_SENTENCE = '这是一段用于填充篇幅的正文，让电子书拥有足够的页数以便定位和恢复阅读位置。';

function chapterXhtml(title, bodyText, fillerRepeats) {
  const paragraphs = Array.from(
    { length: fillerRepeats },
    () => `      <p>${FILLER_SENTENCE}</p>`,
  ).join('\n');
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xml:lang="zh-CN" lang="zh-CN">
  <head>
    <title>${title}</title>
  </head>
  <body>
    <h1>${title}</h1>
    <p>${bodyText}</p>
${paragraphs}
  </body>
</html>
`;
}

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">${EPUB_IDENTIFIER}</dc:identifier>
    <dc:title>${EPUB_TITLE}</dc:title>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2024-01-01T00:00:00Z</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ch1" href="ch1.xhtml" media-type="application/xhtml+xml"/>
    <item id="ch2" href="ch2.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="ch1"/>
    <itemref idref="ch2"/>
  </spine>
</package>
`;

const NAV_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN" lang="zh-CN">
  <head>
    <title>目录</title>
  </head>
  <body>
    <nav epub:type="toc" id="toc">
      <h1>目录</h1>
      <ol>
        <li><a href="ch1.xhtml">第一章</a></li>
        <li><a href="ch2.xhtml">第二章</a></li>
      </ol>
    </nav>
  </body>
</html>
`;

async function makeEpub() {
  const zip = new JSZip();
  const options = { date: FIXED_DATE, createFolders: false };

  // The EPUB spec requires the mimetype entry first and stored uncompressed.
  zip.file('mimetype', 'application/epub+zip', { ...options, compression: 'STORE' });
  zip.file('META-INF/container.xml', CONTAINER_XML, options);
  zip.file('OEBPS/content.opf', CONTENT_OPF, options);
  zip.file('OEBPS/nav.xhtml', NAV_XHTML, options);
  zip.file(
    'OEBPS/ch1.xhtml',
    chapterXhtml('第一章', '第一章正文', 60),
    options,
  );
  zip.file(
    'OEBPS/ch2.xhtml',
    chapterXhtml('第二章', '第二章正文', 60),
    options,
  );

  return zip.generateAsync({
    type: 'nodebuffer',
    compression: 'DEFLATE',
    compressionOptions: { level: 9 },
    platform: 'DOS',
  });
}

/**
 * The reflow pack mirrors reader.pdf page for page: one paragraph naming each
 * page, page 1's unique phrase, and a TOC entry pointing at page 3. Every
 * value is pinned so the JSON is byte-for-byte stable across runs.
 */
function makeReflowPack(sha256) {
  const pages = Array.from({ length: PAGE_COUNT }, (_, index) => {
    const page = index + 1;
    const blocks = [
      {
        id: `p${page}-b0`,
        type: 'paragraph',
        text: `Bookr reader fixture - page ${page}`,
        rect: { x: 0.11, y: 0.07, w: 0.55, h: 0.04 },
      },
    ];
    if (page === 1) {
      blocks.push({
        id: 'p1-b1',
        type: 'paragraph',
        text: 'The quick brown fox jumps over the lazy dog',
        rect: { x: 0.11, y: 0.12, w: 0.7, h: 0.04 },
      });
    }
    return { page, width: US_LETTER[0], height: US_LETTER[1], blocks };
  });

  return {
    schemaVersion: 1,
    source: { sha256, pageCount: PAGE_COUNT },
    generatedAt: '2024-01-01T00:00:00.000Z',
    tool: { name: 'bookr-preprocess', version: 'e2e' },
    quality: {
      pages: PAGE_COUNT,
      textBlocks: PAGE_COUNT + 1,
      fallbackPages: [],
      ocrPages: [],
      avgConfidence: null,
      warnings: [],
    },
    toc: [{ label: '第 3 页', page: 3, level: 1 }],
    pages,
  };
}

mkdirSync(fixturesDir, { recursive: true });
const pdfBytes = await makePdf();
writeFileSync(join(fixturesDir, 'reader.pdf'), pdfBytes);
const sha256 = createHash('sha256').update(pdfBytes).digest('hex');
writeFileSync(join(fixturesDir, 'reader.epub'), await makeEpub());
// The pack must be written from the exact bytes the server will hash: the
// create-upload call declares this sha256 and the server compares it to the book.
writeFileSync(
  join(fixturesDir, 'reader.bookr.json'),
  JSON.stringify(makeReflowPack(sha256), null, 2),
);

console.log(`Wrote reader fixtures to ${fixturesDir}`);
