import { useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent } from 'react';
import { MAX_REFLOW_PACK_BYTES } from '@bookr/shared';
import type { BookDto, CompleteReflowUploadResponse } from '@bookr/shared';
import { Button, cn } from '@bookr/ui';
import { ApiError } from '../../api/client';
import {
  MAX_REFLOW_PACK_MB,
  REFLOW_PACK_EXTENSION_MESSAGE,
  REFLOW_PACK_SIZE_MESSAGE,
  deleteReflowPack,
  reflowPackErrorMessage,
  uploadReflowPack,
} from '../../api/reflow';

export interface ReflowPackSectionProps {
  book: BookDto;
  /** Called after a successful upload or removal so the shelf can refetch. */
  onChanged?: (book: BookDto) => void;
  /** Injectable pipeline; defaults to the real presigned upload. */
  upload?: (
    file: File,
    onProgress: (percent: number) => void,
  ) => Promise<CompleteReflowUploadResponse>;
  /** Injectable removal; defaults to the real DELETE request. */
  remove?: () => Promise<void>;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

/**
 * Server errors are localized by code/reason; local validation and network
 * failures keep their own message so the user can act on them.
 */
function errorMessageFor(error: unknown): string {
  if (error instanceof ApiError) return reflowPackErrorMessage(error);
  if (error instanceof Error && error.message) return error.message;
  return '操作失败，请稍后重试';
}

/**
 * Reflow pack management for a PDF book. One pack may be replaced or removed;
 * success updates local state immediately and notifies the parent so the
 * cached book refetches.
 */
export function ReflowPackSection({
  book,
  onChanged,
  upload,
  remove,
}: ReflowPackSectionProps) {
  const inputId = useId();
  const [current, setCurrent] = useState(book);
  const [progress, setProgress] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const [removing, setRemoving] = useState(false);
  const activeUpload = useRef<AbortController | null>(null);
  const mounted = useRef(true);

  // The edit dialog keeps its own snapshot of the book, so reflect any newer
  // object the parent passes in (for example after a refetch).
  useEffect(() => setCurrent(book), [book]);

  // Closing the dialog aborts whatever is still in flight and parks setState.
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      activeUpload.current?.abort();
    };
  }, []);

  if (book.format !== 'pdf') return null;

  const busy = progress !== null || removing;

  function cancelUpload() {
    activeUpload.current?.abort();
    setProgress(null);
  }

  async function handleFileChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    // Reset so choosing the same file again still fires a change event.
    event.target.value = '';
    if (!file) return;

    setError(null);
    setConfirmingRemove(false);

    if (!file.name.toLowerCase().endsWith('.json')) {
      setError(REFLOW_PACK_EXTENSION_MESSAGE);
      return;
    }
    if (file.size > MAX_REFLOW_PACK_BYTES) {
      setError(REFLOW_PACK_SIZE_MESSAGE);
      return;
    }

    const controller = new AbortController();
    activeUpload.current = controller;
    setProgress(0);

    const reportProgress = (percent: number) => {
      if (mounted.current && !controller.signal.aborted) setProgress(percent);
    };

    try {
      const result = await (upload
        ? upload(file, reportProgress)
        : uploadReflowPack(book.id, file, {
            onProgress: reportProgress,
            signal: controller.signal,
          }));
      if (!mounted.current || controller.signal.aborted) return;
      setCurrent(result.book);
      onChanged?.(result.book);
    } catch (failure) {
      if (!mounted.current || controller.signal.aborted || isAbortError(failure)) return;
      setError(errorMessageFor(failure));
    } finally {
      // A cancelled upload may already have been replaced by a new one; only
      // the controller that still owns the slot may clear its progress.
      if (activeUpload.current === controller) {
        activeUpload.current = null;
        if (mounted.current) setProgress(null);
      }
    }
  }

  async function handleRemove() {
    setError(null);
    setRemoving(true);
    try {
      await (remove ?? (() => deleteReflowPack(book.id)))();
      if (!mounted.current) return;
      const next: BookDto = {
        ...current,
        reflowAvailable: false,
        reflowSchemaVersion: null,
        reflowPageCount: null,
      };
      setCurrent(next);
      setConfirmingRemove(false);
      onChanged?.(next);
    } catch (failure) {
      if (!mounted.current) return;
      setError(errorMessageFor(failure));
    } finally {
      if (mounted.current) setRemoving(false);
    }
  }

  return (
    <div className="flex flex-col gap-2 rounded-md border border-border px-3 py-2">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <span className="text-sm font-medium text-ink">重排包</span>
        {current.reflowAvailable ? (
          <span className="text-xs text-accent">
            已上传 · {current.reflowPageCount} 页 · schema v{current.reflowSchemaVersion}
          </span>
        ) : (
          <span className="text-xs text-muted">尚未上传重排包</span>
        )}
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <input
          id={inputId}
          type="file"
          accept=".json,application/json"
          aria-label="选择重排包"
          disabled={busy}
          onChange={handleFileChange}
          className={cn(
            'text-xs text-muted file:mr-3 file:rounded-md file:border file:border-border',
            'file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-ink',
            'hover:file:bg-ink/5 disabled:opacity-60',
          )}
        />
        {current.reflowAvailable ? (
          confirmingRemove ? (
            <>
              <Button
                variant="danger"
                size="sm"
                loading={removing}
                onClick={handleRemove}
              >
                确认移除
              </Button>
              <Button
                variant="ghost"
                size="sm"
                disabled={removing}
                onClick={() => setConfirmingRemove(false)}
              >
                取消
              </Button>
            </>
          ) : (
            <Button
              variant="ghost"
              size="sm"
              disabled={busy}
              onClick={() => setConfirmingRemove(true)}
            >
              移除重排包
            </Button>
          )
        ) : null}
      </div>

      <p className="text-xs text-muted">
        上传预处理器生成的 .bookr.json 重排包，不超过 {MAX_REFLOW_PACK_MB} MB。
      </p>

      {progress !== null ? (
        <div className="flex flex-wrap items-center gap-2">
          <p role="status" className="text-xs text-muted">
            上传中 {progress}%
          </p>
          <Button variant="ghost" size="sm" onClick={cancelUpload}>
            取消上传
          </Button>
        </div>
      ) : null}

      {error ? (
        <p role="alert" className="text-xs text-highlight">
          {error}
        </p>
      ) : null}
    </div>
  );
}
