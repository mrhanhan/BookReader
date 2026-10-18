import type { BookFormat } from '@bookr/shared';
import { extractMetadata } from './metadata';

const FORMATS: ReadonlySet<string> = new Set<BookFormat>(['pdf', 'epub', 'mobi', 'azw3']);

/** Reads the book file sent by the parent over stdin. */
async function readStdin(): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}

/**
 * Isolated metadata parser. The parent (`ProcessMetadataRunner`) caps this
 * process's heap and lifetime; this script only exchanges JSON over stdio and
 * never writes book text or parser messages anywhere.
 */
async function main(): Promise<void> {
  const format = process.argv[2];
  if (!format || !FORMATS.has(format)) {
    throw new Error('Unsupported format');
  }

  const buffer = await readStdin();
  const extracted = await extractMetadata({ buffer, format: format as BookFormat });

  const wire = {
    ...(extracted.title ? { title: extracted.title } : {}),
    ...(extracted.author ? { author: extracted.author } : {}),
    ...(extracted.description ? { description: extracted.description } : {}),
    ...(extracted.cover
      ? {
          cover: {
            contentType: extracted.cover.contentType,
            data: extracted.cover.data.toString('base64'),
          },
        }
      : {}),
    ...(extracted.coverError !== undefined
      ? {
          coverErrorName:
            extracted.coverError instanceof Error
              ? extracted.coverError.name
              : typeof extracted.coverError,
        }
      : {}),
  };

  await new Promise<void>((resolve, reject) => {
    process.stdout.write(JSON.stringify(wire), (error) => (error ? reject(error) : resolve()));
  });
}

main().catch(() => {
  // Fixed text only: parser messages may contain book text.
  process.stderr.write('metadata worker failed\n');
  process.exit(1);
});
