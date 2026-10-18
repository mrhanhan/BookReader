import AdmZip from 'adm-zip';
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { PDFDocument, StandardFonts, rgb } from 'pdf-lib';
import { PNG } from 'pngjs';

const serverRoot = join(import.meta.dirname, '..');
const fixturesDir = join(serverRoot, 'test', 'fixtures');

/** Builds a 32x32 gradient PNG so the fixture is comfortably larger than 100 bytes. */
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

const CONTAINER_XML = `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;

const CONTENT_OPF = `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="book-id">urn:uuid:00000000-0000-4000-8000-000000000001</dc:identifier>
    <dc:title>测试之书</dc:title>
    <dc:creator>张三</dc:creator>
    <dc:description>一本用于测试元数据提取的书。</dc:description>
    <dc:language>zh-CN</dc:language>
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="cover-image" href="cover.png" media-type="image/png" properties="cover-image"/>
    <item id="chapter-1" href="chapter1.xhtml" media-type="application/xhtml+xml"/>
  </manifest>
  <spine>
    <itemref idref="chapter-1"/>
  </spine>
</package>
`;

const CHAPTER_XHTML = `<?xml version="1.0" encoding="UTF-8"?>
<html xmlns="http://www.w3.org/1999/xhtml">
  <head><title>第一章</title></head>
  <body><h1>第一章</h1><p>测试正文。</p></body>
</html>
`;

function makeEpub(): Buffer {
  // Keep insertion order (the EPUB spec requires "mimetype" first) and store
  // it uncompressed, which adm-zip lets us set per entry.
  const zip = new AdmZip({ noSort: true });
  const mimetype = zip.addFile('mimetype', Buffer.from('application/epub+zip', 'utf8'));
  mimetype.header.method = 0;
  zip.addFile('META-INF/container.xml', Buffer.from(CONTAINER_XML, 'utf8'));
  zip.addFile('OEBPS/content.opf', Buffer.from(CONTENT_OPF, 'utf8'));
  zip.addFile('OEBPS/chapter1.xhtml', Buffer.from(CHAPTER_XHTML, 'utf8'));
  zip.addFile('OEBPS/cover.png', makeCoverPng());
  return zip.toBuffer();
}

async function makePdf(): Promise<Buffer> {
  const pdf = await PDFDocument.create();
  pdf.setTitle('PDF 测试');
  pdf.setAuthor('李四');
  pdf.setSubject('一本用于测试元数据提取的 PDF。');
  pdf.setCreator('Bookr fixtures');

  const page = pdf.addPage([595.28, 841.89]);
  const font = await pdf.embedFont(StandardFonts.HelveticaBold);
  page.drawText('Bookr PDF fixture', {
    x: 72,
    y: 760,
    size: 28,
    font,
    color: rgb(0.12, 0.2, 0.35),
  });
  page.drawRectangle({
    x: 72,
    y: 640,
    width: 451,
    height: 80,
    color: rgb(0.9, 0.93, 0.97),
  });

  return Buffer.from(await pdf.save());
}

mkdirSync(fixturesDir, { recursive: true });
writeFileSync(join(fixturesDir, 'sample.epub'), makeEpub());
writeFileSync(join(fixturesDir, 'sample.pdf'), await makePdf());

console.log(`Wrote fixtures to ${fixturesDir}`);
