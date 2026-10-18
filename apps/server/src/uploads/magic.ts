import type { BookFormat } from '@bookr/shared';

const PDF_MAGIC = Buffer.from('%PDF-', 'latin1');
const ZIP_MAGIC = Buffer.from([0x50, 0x4b, 0x03, 0x04]);
const MOBI_MAGIC = Buffer.from('BOOKMOBI', 'latin1');

/** Byte offset of the MOBI type marker in the Palm database header. */
const MOBI_MAGIC_OFFSET = 60;

/** Number of leading bytes needed to validate a file of the given format. */
export function magicBytesNeeded(format: BookFormat): number {
  return format === 'mobi' || format === 'azw3' ? MOBI_MAGIC_OFFSET + MOBI_MAGIC.length : 16;
}

/**
 * Checks a file's leading bytes against the expected container signature.
 * The extension and declared content type are client claims; this is the
 * server-side check that the bytes actually are a book of that format.
 */
export function sniffMagic(head: Buffer, format: BookFormat): boolean {
  switch (format) {
    case 'pdf':
      return head.subarray(0, PDF_MAGIC.length).equals(PDF_MAGIC);
    case 'epub':
      return head.subarray(0, ZIP_MAGIC.length).equals(ZIP_MAGIC);
    case 'mobi':
    case 'azw3':
      return (
        head
          .subarray(MOBI_MAGIC_OFFSET, MOBI_MAGIC_OFFSET + MOBI_MAGIC.length)
          .equals(MOBI_MAGIC)
      );
  }
}
