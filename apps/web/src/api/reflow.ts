import type {
  CompleteReflowUploadResponse,
  CreateReflowUploadResponse,
  PresignedUploadTarget,
  ReflowFileInfo,
} from '@bookr/shared';
import { apiFetch } from './client';
import { postWithProgress } from '../lib/upload';

/** Signed download details for the stored pack of a PDF book. */
export function fetchReflowFile(bookId: string): Promise<ReflowFileInfo> {
  return apiFetch<ReflowFileInfo>(`/api/books/${encodeURIComponent(bookId)}/reflow`);
}

/** Opens a presigned upload session for a replacement reflow pack. */
export function createReflowUpload(
  bookId: string,
  input: { size: number; sha256: string },
): Promise<CreateReflowUploadResponse> {
  return apiFetch<CreateReflowUploadResponse>(
    `/api/books/${encodeURIComponent(bookId)}/reflow/uploads`,
    { method: 'POST', body: JSON.stringify(input) },
  );
}

/** Validates the uploaded pack and attaches it to the book. */
export function completeReflowUpload(
  bookId: string,
  uploadId: string,
): Promise<CompleteReflowUploadResponse> {
  return apiFetch<CompleteReflowUploadResponse>(
    `/api/books/${encodeURIComponent(bookId)}/reflow/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: 'POST' },
  );
}

/** Removes the stored pack; the server answers with an empty 204. */
export function deleteReflowPack(bookId: string): Promise<void> {
  return apiFetch<void>(`/api/books/${encodeURIComponent(bookId)}/reflow`, {
    method: 'DELETE',
  });
}

const SHA256_PATTERN = /^[0-9a-f]{64}$/;

/**
 * The create request's `sha256` is the *source book's* hash, which the server
 * compares with the book row before signing the upload. The browser cannot
 * derive it from the PDF, so it declares the value the pack embeds in
 * `source.sha256`; completion verifies that same field against the book again.
 */
async function readPackSourceHash(file: File, signal?: AbortSignal): Promise<string> {
  const text = await file.text();
  if (signal?.aborted) {
    throw new DOMException('上传已取消', 'AbortError');
  }

  let pack: unknown;
  try {
    pack = JSON.parse(text);
  } catch {
    throw new Error('重排包不是有效的 JSON 文件');
  }

  const sha256 =
    typeof pack === 'object' && pack !== null
      ? (pack as { source?: { sha256?: unknown } }).source?.sha256
      : undefined;
  if (typeof sha256 !== 'string' || !SHA256_PATTERN.test(sha256)) {
    throw new Error('重排包缺少有效的 source.sha256');
  }
  return sha256;
}

/** Upload steps, injectable so tests never touch the network. */
export interface ReflowUploadDeps {
  hash: (file: File, signal?: AbortSignal) => Promise<string>;
  create: (
    bookId: string,
    input: { size: number; sha256: string },
  ) => Promise<CreateReflowUploadResponse>;
  post: (
    target: PresignedUploadTarget,
    file: File,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  complete: (bookId: string, uploadId: string) => Promise<CompleteReflowUploadResponse>;
}

export interface UploadReflowPackOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  deps?: Partial<ReflowUploadDeps>;
}

function defaultDeps(): ReflowUploadDeps {
  return {
    hash: readPackSourceHash,
    create: createReflowUpload,
    post: postWithProgress,
    complete: completeReflowUpload,
  };
}

function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) {
    throw new DOMException('上传已取消', 'AbortError');
  }
}

/**
 * Runs the reflow pack pipeline: resolve the declared source hash, create a
 * presigned session, POST the pack with progress, then complete it. Errors are
 * left untouched so the UI can map the server's `ApiError` codes.
 */
export async function uploadReflowPack(
  bookId: string,
  file: File,
  options: UploadReflowPackOptions = {},
): Promise<CompleteReflowUploadResponse> {
  const deps: ReflowUploadDeps = { ...defaultDeps(), ...options.deps };
  const { signal } = options;
  throwIfAborted(signal);

  const sha256 = await deps.hash(file, signal);
  throwIfAborted(signal);

  const created = await deps.create(bookId, { size: file.size, sha256 });
  throwIfAborted(signal);

  const reportProgress = (percent: number) => {
    options.onProgress?.(Math.max(0, Math.min(100, Math.round(percent))));
  };
  await deps.post(created.upload, file, reportProgress, signal);
  throwIfAborted(signal);

  const completed = await deps.complete(bookId, created.uploadId);
  options.onProgress?.(100);
  return completed;
}
