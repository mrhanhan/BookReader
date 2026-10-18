import { MAX_REFLOW_PACK_BYTES } from '@bookr/shared';
import type {
  CompleteReflowUploadResponse,
  CreateReflowUploadResponse,
  PresignedUploadTarget,
  ReflowFileInfo,
} from '@bookr/shared';
import { ApiError, apiFetch } from './client';
import { messageForApiError } from '../lib/errorMessages';
import { postWithProgress } from '../lib/upload';

/** The 32 MiB server limit, in whole megabytes for display. */
export const MAX_REFLOW_PACK_MB = Math.round(MAX_REFLOW_PACK_BYTES / 1024 / 1024);

/** Copy shared by the section and the pipeline's own defence-in-depth guards. */
export const REFLOW_PACK_EXTENSION_MESSAGE = '仅支持 .bookr.json 重排包';
export const REFLOW_PACK_SIZE_MESSAGE = `重排包不能超过 ${MAX_REFLOW_PACK_MB} MB`;

/** Completion failures carry a machine-readable reason; show one line per case. */
const REFLOW_INVALID_REASONS: Record<string, string> = {
  'pack/invalid': '重排包格式无效，请重新生成',
  'pack/source-mismatch': '重排包与当前图书的源文件不匹配',
  'pack/size': '重排包大小不符，请重新生成',
  'pack/missing': '上传未完成，请重试',
};

/**
 * Localizes a reflow failure. `REFLOW_INVALID` is broad on the wire, so its
 * `details.reason` distinguishes a malformed pack from a pack that belongs to
 * another book; anything unrecognised keeps the generic code message.
 */
export function reflowPackErrorMessage(error: ApiError): string {
  if (error.code === 'REFLOW_INVALID') {
    const reason = error.details?.reason;
    if (typeof reason === 'string' && REFLOW_INVALID_REASONS[reason]) {
      return REFLOW_INVALID_REASONS[reason];
    }
  }
  return messageForApiError(error);
}

/** Signed download details for the stored pack of a PDF book. */
export function fetchReflowFile(bookId: string): Promise<ReflowFileInfo> {
  return apiFetch<ReflowFileInfo>(`/api/books/${encodeURIComponent(bookId)}/reflow`);
}

/** Opens a presigned upload session for a replacement reflow pack. */
export function createReflowUpload(
  bookId: string,
  input: { size: number; sha256: string },
  signal?: AbortSignal,
): Promise<CreateReflowUploadResponse> {
  return apiFetch<CreateReflowUploadResponse>(
    `/api/books/${encodeURIComponent(bookId)}/reflow/uploads`,
    { method: 'POST', body: JSON.stringify(input), signal },
  );
}

/** Validates the uploaded pack and attaches it to the book. */
export function completeReflowUpload(
  bookId: string,
  uploadId: string,
  signal?: AbortSignal,
): Promise<CompleteReflowUploadResponse> {
  return apiFetch<CompleteReflowUploadResponse>(
    `/api/books/${encodeURIComponent(bookId)}/reflow/uploads/${encodeURIComponent(uploadId)}/complete`,
    { method: 'POST', signal },
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
    signal?: AbortSignal,
  ) => Promise<CreateReflowUploadResponse>;
  post: (
    target: PresignedUploadTarget,
    file: File,
    onProgress: (percent: number) => void,
    signal?: AbortSignal,
  ) => Promise<void>;
  complete: (
    bookId: string,
    uploadId: string,
    signal?: AbortSignal,
  ) => Promise<CompleteReflowUploadResponse>;
}

export interface UploadReflowPackOptions {
  onProgress?: (percent: number) => void;
  signal?: AbortSignal;
  deps?: Partial<ReflowUploadDeps>;
}

function defaultDeps(): ReflowUploadDeps {
  return {
    hash: readPackSourceHash,
    create: (bookId, input, signal) => createReflowUpload(bookId, input, signal),
    post: postWithProgress,
    complete: (bookId, uploadId, signal) =>
      completeReflowUpload(bookId, uploadId, signal),
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

  // The UI validates before starting, but the pipeline must not create a
  // session for a file it can never complete.
  if (!file.name.toLowerCase().endsWith('.json')) {
    throw new Error(REFLOW_PACK_EXTENSION_MESSAGE);
  }
  if (file.size > MAX_REFLOW_PACK_BYTES) {
    throw new Error(REFLOW_PACK_SIZE_MESSAGE);
  }

  const sha256 = await deps.hash(file, signal);
  throwIfAborted(signal);

  const created = await deps.create(bookId, { size: file.size, sha256 }, signal);
  throwIfAborted(signal);

  const reportProgress = (percent: number) => {
    options.onProgress?.(Math.max(0, Math.min(100, Math.round(percent))));
  };
  await deps.post(created.upload, file, reportProgress, signal);
  throwIfAborted(signal);

  // The signal also covers completion so an abort in the attach window cannot
  // leave the caller reporting success after the dialog has moved on.
  const completed = await deps.complete(bookId, created.uploadId, signal);
  throwIfAborted(signal);

  options.onProgress?.(100);
  return completed;
}
