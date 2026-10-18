import { MAX_UPLOAD_BYTES } from '@bookr/shared/constants';
import type {
  BookDto,
  CompleteUploadResponse,
  CreateUploadResponse,
} from '@bookr/shared';
import { ApiError, apiFetch } from '../api/client';
import { messageForApiError } from './errorMessages';

/** A problem with the chosen file that the user can fix by choosing another. */
export class InvalidFileError extends Error {
  constructor(message = '文件无效或格式不受支持') {
    super(message);
    this.name = 'InvalidFileError';
  }
}

/** The shelf already holds a live book with the same content. */
export class DuplicateBookError extends Error {
  readonly existingBookId: string | null;

  constructor(existingBookId: string | null = null) {
    super('这本书已经在书架里了');
    this.name = 'DuplicateBookError';
    this.existingBookId = existingBookId;
  }
}

/** The shared library or the member's own quota cannot hold the file. */
export class QuotaExceededError extends Error {
  constructor(message = '共享书库空间不足，请联系管理员') {
    super(message);
    this.name = 'QuotaExceededError';
  }
}

export interface CreateUploadInput {
  filename: string;
  size: number;
  sha256: string;
  contentType: string;
}

/** Upload steps, injectable so tests (and the dialog) never touch the network. */
export interface UploadDeps {
  hash: (file: File, signal?: AbortSignal) => Promise<string>;
  create: (input: CreateUploadInput, signal?: AbortSignal) => Promise<CreateUploadResponse>;
  put: (
    url: string,
    file: File,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  complete: (
    uploadId: string,
    signal?: AbortSignal,
  ) => Promise<CompleteUploadResponse>;
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
}

/** The observable slice of the upload pipeline a caller controls. */
export type UploadOptions = Pick<UploadDeps, 'onProgress' | 'signal'>;

const CONTENT_TYPE_BY_EXTENSION: Record<string, string> = {
  pdf: 'application/pdf',
  epub: 'application/epub+zip',
  mobi: 'application/x-mobipocket-ebook',
  azw3: 'application/vnd.amazon.ebook',
};

function extensionOf(filename: string): string {
  const dot = filename.lastIndexOf('.');
  return dot >= 0 ? filename.slice(dot + 1).toLowerCase() : '';
}

/**
 * Resolves the content type from the extension rather than `File.type`.
 * The server derives the format from the extension and rejects a mismatch,
 * and the presigned PUT signs the content type, so both steps must agree.
 */
export function contentTypeForFile(file: File): string {
  const contentType = CONTENT_TYPE_BY_EXTENSION[extensionOf(file.name)];
  if (!contentType) {
    throw new InvalidFileError('仅支持 PDF、EPUB、MOBI 或 AZW3 文件');
  }
  return contentType;
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('上传已取消', 'AbortError');
  }
}

/** Translates API codes into the small set of upload failures the UI shows. */
export function mapUploadError(error: unknown): Error {
  if (
    error instanceof InvalidFileError ||
    error instanceof DuplicateBookError ||
    error instanceof QuotaExceededError
  ) {
    return error;
  }

  if (error instanceof ApiError) {
    switch (error.code) {
      case 'DUPLICATE_BOOK': {
        const id = error.details?.existingBookId;
        return new DuplicateBookError(typeof id === 'string' ? id : null);
      }
      case 'QUOTA_EXCEEDED':
        return new QuotaExceededError();
      case 'INVALID_FILE':
      case 'VALIDATION_FAILED':
        return new InvalidFileError();
      default:
        return new Error(messageForApiError(error));
    }
  }

  return error instanceof Error ? error : new Error('上传失败，请稍后重试');
}

/**
 * PUTs the file to a presigned S3 target with upload progress. XHR is used
 * because `fetch` still cannot report request-body progress.
 */
export function putWithProgress(
  url: string,
  file: File,
  onProgress: (percent: number) => void,
  signal?: AbortSignal,
): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'));
      return;
    }

    const request = new XMLHttpRequest();
    request.open('PUT', url);

    try {
      request.setRequestHeader('Content-Type', contentTypeForFile(file));
    } catch (error) {
      reject(error);
      return;
    }

    const abort = () => request.abort();
    signal?.addEventListener('abort', abort, { once: true });

    request.upload.onprogress = (event) => {
      if (!event.lengthComputable || event.total <= 0) return;
      onProgress(Math.round((event.loaded / event.total) * 100));
    };
    request.onload = () => {
      signal?.removeEventListener('abort', abort);
      if (request.status >= 200 && request.status < 300) {
        onProgress(100);
        resolve();
      } else {
        reject(new Error('文件上传中断，请检查网络后重试'));
      }
    };
    request.onerror = () => {
      signal?.removeEventListener('abort', abort);
      reject(new Error('文件上传中断，请检查网络后重试'));
    };
    request.onabort = () => {
      signal?.removeEventListener('abort', abort);
      reject(new DOMException('上传已取消', 'AbortError'));
    };

    request.send(file);
  });
}

/** Files at or above this size fall back to `crypto.subtle` only when workers fail. */
const SUBTLE_FALLBACK_LIMIT_BYTES = 32 * 1024 * 1024;

interface HashWorkerReply {
  sha256?: string;
  error?: string;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function hashInWorker(file: File, signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('上传已取消', 'AbortError'));
      return;
    }

    const worker = new Worker(new URL('./hash-worker.ts', import.meta.url), {
      type: 'module',
    });
    const abort = () => {
      worker.terminate();
      reject(new DOMException('上传已取消', 'AbortError'));
    };
    signal?.addEventListener('abort', abort, { once: true });

    const finish = (action: () => void) => {
      worker.terminate();
      signal?.removeEventListener('abort', abort);
      action();
    };

    worker.onmessage = (event: MessageEvent<HashWorkerReply>) => {
      const reply = event.data;
      if (reply.sha256) {
        finish(() => resolve(reply.sha256!));
      } else {
        finish(() => reject(new Error(reply.error ?? '无法计算文件校验值')));
      }
    };
    worker.onerror = (event) => {
      finish(() => reject(new Error(event.message || '无法计算文件校验值')));
    };
    worker.postMessage({ file });
  });
}

async function hashWithSubtle(file: File, signal?: AbortSignal): Promise<string> {
  if (typeof crypto === 'undefined' || !crypto.subtle) {
    throw new Error('当前环境不支持文件校验');
  }
  const digest = await crypto.subtle.digest('SHA-256', await file.arrayBuffer());
  // `digest` cannot be interrupted, so honour a cancellation that arrived
  // while the buffer was being read.
  throwIfAborted(signal);
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, '0')).join(
    '',
  );
}

/**
 * Incremental SHA-256 of a file. The worker reads 4 MiB chunks so a 500 MiB
 * book never has to sit in memory at once; small files may use `crypto.subtle`
 * when workers are unavailable or fail.
 */
export async function hashFile(file: File, signal?: AbortSignal): Promise<string> {
  const canUseSubtleFallback = file.size < SUBTLE_FALLBACK_LIMIT_BYTES;
  throwIfAborted(signal);

  if (typeof Worker === 'undefined') {
    if (!canUseSubtleFallback) {
      throw new Error('当前浏览器不支持大文件校验');
    }
    return hashWithSubtle(file, signal);
  }

  try {
    return await hashInWorker(file, signal);
  } catch (error) {
    // A cancelled upload must not silently fall back and keep hashing.
    if (isAbortError(error) || signal?.aborted) throw error;
    if (!canUseSubtleFallback) throw error;
    return hashWithSubtle(file, signal);
  }
}

function defaultDeps(): UploadDeps {
  return {
    hash: hashFile,
    create: async (input, signal) =>
      apiFetch<CreateUploadResponse>('/api/uploads', {
        method: 'POST',
        body: JSON.stringify(input),
        signal,
      }),
    put: putWithProgress,
    complete: async (uploadId, signal) =>
      apiFetch<CompleteUploadResponse>(
        `/api/uploads/${encodeURIComponent(uploadId)}/complete`,
        { method: 'POST', signal },
      ),
  };
}

/**
 * Runs the presigned upload pipeline: size guard, incremental SHA-256,
 * session creation (which also performs the duplicate and quota checks),
 * the direct PUT, then completion. Every failure is normalised to the
 * upload error classes the dialog understands.
 */
export async function uploadBook(
  file: File,
  overrides: Partial<UploadDeps> = {},
): Promise<BookDto> {
  if (file.size > MAX_UPLOAD_BYTES) {
    throw new InvalidFileError('单本上限 500 MB');
  }
  if (file.size <= 0) {
    throw new InvalidFileError('文件是空的，无法上传');
  }

  const contentType = contentTypeForFile(file);
  const deps: UploadDeps = { ...defaultDeps(), ...overrides };
  throwIfAborted(deps.signal);

  try {
    const sha256 = deps.signal ? await deps.hash(file, deps.signal) : await deps.hash(file);
    throwIfAborted(deps.signal);

    const input: CreateUploadInput = {
      filename: file.name,
      size: file.size,
      sha256,
      contentType,
    };
    const created = deps.signal
      ? await deps.create(input, deps.signal)
      : await deps.create(input);
    throwIfAborted(deps.signal);

    const reportProgress = (percent: number) => {
      deps.onProgress?.(Math.max(0, Math.min(100, Math.round(percent))));
    };
    if (deps.signal) {
      await deps.put(created.putUrl, file, reportProgress, deps.signal);
    } else {
      await deps.put(created.putUrl, file, reportProgress);
    }
    throwIfAborted(deps.signal);

    const completed = deps.signal
      ? await deps.complete(created.uploadId, deps.signal)
      : await deps.complete(created.uploadId);

    deps.onProgress?.(100);
    return completed.book;
  } catch (error) {
    throw mapUploadError(error);
  }
}
