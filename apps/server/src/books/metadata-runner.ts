import type { BookFormat } from '@bookr/shared';
import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { extractMetadata, type ExtractedMetadata } from './metadata';

/** Runs metadata extraction for one book file. */
export interface MetadataRunner {
  extract(input: { buffer: Buffer; format: BookFormat }): Promise<ExtractedMetadata>;
}

/** Runs the parser in the API process itself; used by tests and simple setups. */
export class InProcessMetadataRunner implements MetadataRunner {
  extract(input: { buffer: Buffer; format: BookFormat }): Promise<ExtractedMetadata> {
    return extractMetadata(input);
  }
}

/** Raised when the isolated parser crashes, times out or returns garbage. */
class MetadataProcessError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'MetadataProcessError';
  }
}

/** A reader process is abandoned after two minutes. */
export const METADATA_PROCESS_TIMEOUT_MS = 2 * 60 * 1000;

/** V8 old-space ceiling for one parser process. */
export const METADATA_PROCESS_MAX_OLD_MB = 512;

/** Largest JSON result accepted from the parser, including a base64 cover. */
const METADATA_PROCESS_MAX_OUTPUT_BYTES = 64 * 1024 * 1024;

export interface ProcessMetadataRunnerOptions {
  timeoutMs?: number;
  maxOldGenerationMb?: number;
  maxOutputBytes?: number;
}

/** Wire format written by `metadata-worker.ts`. */
interface WireMetadata {
  title?: unknown;
  author?: unknown;
  description?: unknown;
  cover?: unknown;
  coverErrorName?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Locates the worker next to either the bundled server (`dist/books/...`) or
 * the TypeScript sources (`src/books/...` when running under tsx or vitest).
 */
function resolveWorkerPath(): string {
  const candidates = [
    './books/metadata-worker.js',
    './metadata-worker.js',
    './metadata-worker.ts',
    './books/metadata-worker.ts',
  ];
  for (const candidate of candidates) {
    const path = fileURLToPath(new URL(candidate, import.meta.url));
    if (existsSync(path)) {
      return path;
    }
  }
  throw new MetadataProcessError('Metadata worker was not found');
}

/** Rebuilds the extracted metadata from the worker's JSON response. */
function decodeWire(raw: Buffer): ExtractedMetadata {
  const parsed = JSON.parse(raw.toString('utf8')) as unknown;
  if (!isRecord(parsed)) {
    throw new MetadataProcessError('Metadata process returned an invalid result');
  }

  const wire = parsed as WireMetadata;
  const result: ExtractedMetadata = {};
  if (typeof wire.title === 'string') result.title = wire.title;
  if (typeof wire.author === 'string') result.author = wire.author;
  if (typeof wire.description === 'string') result.description = wire.description;

  if (isRecord(wire.cover)) {
    const { data, contentType } = wire.cover;
    if (
      typeof data === 'string' &&
      (contentType === 'image/png' || contentType === 'image/jpeg')
    ) {
      result.cover = { data: Buffer.from(data, 'base64'), contentType };
    }
  }

  if (typeof wire.coverErrorName === 'string') {
    // Only the class name crosses the boundary: parser messages may contain
    // book text, and only the name is ever logged.
    const error = new Error('Cover extraction failed');
    error.name = wire.coverErrorName;
    result.coverError = error;
  }

  return result;
}

/**
 * Runs EPUB/PDF parsing in a child process with a hard heap cap and timeout,
 * so a crafted archive or PDF cannot exhaust the API process (spec §12).
 * The file is sent over stdin and the result is returned as JSON.
 */
export class ProcessMetadataRunner implements MetadataRunner {
  private readonly timeoutMs: number;
  private readonly maxOldGenerationMb: number;
  private readonly maxOutputBytes: number;

  constructor(options: ProcessMetadataRunnerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? METADATA_PROCESS_TIMEOUT_MS;
    this.maxOldGenerationMb = options.maxOldGenerationMb ?? METADATA_PROCESS_MAX_OLD_MB;
    this.maxOutputBytes = options.maxOutputBytes ?? METADATA_PROCESS_MAX_OUTPUT_BYTES;
  }

  extract(input: { buffer: Buffer; format: BookFormat }): Promise<ExtractedMetadata> {
    const workerPath = resolveWorkerPath();
    const args = [
      // Node's native type stripping cannot resolve the extensionless imports
      // used by the sources, so development runs load tsx in the child.
      ...(workerPath.endsWith('.ts') ? ['--import', 'tsx'] : []),
      `--max-old-space-size=${this.maxOldGenerationMb}`,
      workerPath,
      input.format,
    ];

    return new Promise<ExtractedMetadata>((resolve, reject) => {
      const child = spawn(process.execPath, args, {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      });

      let settled = false;
      let timedOut = false;
      let outputBytes = 0;
      const output: Buffer[] = [];

      const finish = (error?: Error, result?: ExtractedMetadata): void => {
        if (settled) {
          return;
        }
        settled = true;
        clearTimeout(timer);
        if (error) {
          reject(error);
        } else {
          resolve(result!);
        }
      };

      const timer = setTimeout(() => {
        timedOut = true;
        child.kill('SIGKILL');
      }, this.timeoutMs);
      timer.unref?.();

      child.once('error', () => {
        finish(new MetadataProcessError('Metadata process could not be started'));
      });

      child.stdout.on('data', (chunk: Buffer) => {
        outputBytes += chunk.length;
        if (outputBytes > this.maxOutputBytes) {
          child.kill('SIGKILL');
          finish(new MetadataProcessError('Metadata process produced too much output'));
          return;
        }
        output.push(chunk);
      });

      // Parser diagnostics are deliberately dropped: they may quote book text.
      child.stderr.on('data', () => undefined);
      // A child that rejects the input (bad args, OOM) closes stdin early;
      // the close handler reports the real failure.
      child.stdin.on('error', () => undefined);

      child.once('close', (code) => {
        if (timedOut) {
          finish(new MetadataProcessError('Metadata process timed out'));
          return;
        }
        if (code !== 0) {
          finish(new MetadataProcessError(`Metadata process exited with code ${code ?? 'unknown'}`));
          return;
        }
        try {
          finish(undefined, decodeWire(Buffer.concat(output, outputBytes)));
        } catch {
          finish(new MetadataProcessError('Metadata process returned an invalid result'));
        }
      });

      child.stdin.end(input.buffer);
    });
  }
}
