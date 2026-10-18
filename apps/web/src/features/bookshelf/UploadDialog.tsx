import { useCallback, useEffect, useId, useRef, useState } from 'react';
import type { ChangeEvent, DragEvent } from 'react';
import type { BookDto } from '@bookr/shared';
import { Button, Dialog, cn } from '@bookr/ui';
import { Link } from 'react-router';
import { formatBytes } from '../../lib/format';
import {
  DuplicateBookError,
  InvalidFileError,
  QuotaExceededError,
  uploadBook,
} from '../../lib/upload';
import type { UploadOptions } from '../../lib/upload';

/** Three parallel PUTs is enough to saturate a home connection without thrashing. */
const MAX_CONCURRENT_UPLOADS = 3;

const ACCEPTED_EXTENSIONS = /\.(pdf|epub|mobi|azw3)$/i;

export type UploadFn = (file: File, options: UploadOptions) => Promise<BookDto>;

export interface UploadDialogProps {
  onClose: () => void;
  /** Called after every successful book so the shelf can refresh and toast. */
  onUploaded?: (book: BookDto) => void;
  /** Injectable pipeline; defaults to the real presigned upload. */
  upload?: UploadFn;
}

type ItemStatus = 'queued' | 'hashing' | 'uploading' | 'done' | 'error' | 'cancelled';

interface UploadFailure {
  kind: 'duplicate' | 'quota' | 'invalid' | 'other';
  message: string;
  existingBookId: string | null;
}

interface QueueItem {
  id: string;
  file: File;
  status: ItemStatus;
  progress: number;
  failure: UploadFailure | null;
}

function isAbortError(error: unknown): boolean {
  return (
    typeof error === 'object' &&
    error !== null &&
    (error as { name?: unknown }).name === 'AbortError'
  );
}

function toFailure(error: unknown): UploadFailure {
  if (error instanceof DuplicateBookError) {
    return {
      kind: 'duplicate',
      message: '这本书已经在书架里了',
      existingBookId: error.existingBookId,
    };
  }
  if (error instanceof QuotaExceededError) {
    return {
      kind: 'quota',
      message: '共享书库空间不足，请联系管理员',
      existingBookId: null,
    };
  }
  if (error instanceof InvalidFileError) {
    return { kind: 'invalid', message: error.message, existingBookId: null };
  }
  return {
    kind: 'other',
    message:
      error instanceof Error && error.message ? error.message : '上传失败，请稍后重试',
    existingBookId: null,
  };
}

function isActive(status: ItemStatus): boolean {
  return status === 'queued' || status === 'hashing' || status === 'uploading';
}

/**
 * Drag-and-drop upload queue with per-file progress, cancellation and the
 * duplicate/quota feedback the shelf needs. Uploads run at most three at a
 * time; the dialog closes itself once a batch finishes without errors.
 */
export function UploadDialog({ onClose, onUploaded, upload }: UploadDialogProps) {
  const inputId = useId();
  const [items, setItems] = useState<QueueItem[]>([]);
  const [dragging, setDragging] = useState(false);

  // Queue mechanics live in refs so a pump can run synchronously without
  // waiting for React to re-render between files.
  const nextId = useRef(0);
  const pending = useRef<{ id: string; file: File }[]>([]);
  const active = useRef(0);
  const controllers = useRef(new Map<string, AbortController>());
  const outcome = useRef({ success: 0, failure: 0 });
  const closing = useRef(false);

  const uploadRef = useRef<UploadFn>(upload ?? ((file, options) => uploadBook(file, options)));
  const onUploadedRef = useRef(onUploaded);
  const onCloseRef = useRef(onClose);
  useEffect(() => {
    uploadRef.current = upload ?? ((file, options) => uploadBook(file, options));
    onUploadedRef.current = onUploaded;
    onCloseRef.current = onClose;
  }, [upload, onUploaded, onClose]);

  // Closing the dialog (or navigating away) aborts whatever is still in flight.
  useEffect(() => {
    const running = controllers.current;
    return () => {
      for (const controller of running.values()) controller.abort();
      pending.current = [];
    };
  }, []);

  const updateItem = useCallback((id: string, patch: Partial<QueueItem>) => {
    setItems((current) =>
      current.map((item) => (item.id === id ? { ...item, ...patch } : item)),
    );
  }, []);

  function maybeFinish() {
    if (closing.current) return;
    if (active.current > 0 || pending.current.length > 0) return;
    if (outcome.current.success === 0 || outcome.current.failure > 0) return;

    closing.current = true;
    onCloseRef.current();
  }

  function runOne(id: string, file: File) {
    const controller = new AbortController();
    controllers.current.set(id, controller);
    updateItem(id, { status: 'hashing', progress: 0, failure: null });

    void uploadRef
      .current(file, {
        signal: controller.signal,
        onProgress: (percent) => {
          updateItem(id, {
            status: 'uploading',
            progress: Math.max(0, Math.min(100, Math.round(percent))),
          });
        },
      })
      .then((book) => {
        outcome.current.success += 1;
        updateItem(id, { status: 'done', progress: 100, failure: null });
        onUploadedRef.current?.(book);
      })
      .catch((error: unknown) => {
        outcome.current.failure += 1;
        if (isAbortError(error)) {
          updateItem(id, { status: 'cancelled' });
        } else {
          updateItem(id, { status: 'error', failure: toFailure(error) });
        }
      })
      .finally(() => {
        controllers.current.delete(id);
        active.current -= 1;
        pump();
        maybeFinish();
      });
  }

  function pump() {
    while (active.current < MAX_CONCURRENT_UPLOADS && pending.current.length > 0) {
      const next = pending.current.shift();
      if (!next) break;
      active.current += 1;
      runOne(next.id, next.file);
    }
  }

  function enqueue(files: File[]) {
    if (files.length === 0) return;

    const additions: QueueItem[] = files.map((file) => {
      const id = `upload-${nextId.current++}`;
      if (ACCEPTED_EXTENSIONS.test(file.name)) {
        pending.current.push({ id, file });
        return { id, file, status: 'queued', progress: 0, failure: null };
      }

      outcome.current.failure += 1;
      return {
        id,
        file,
        status: 'error',
        progress: 0,
        failure: {
          kind: 'invalid',
          message: '仅支持 PDF、EPUB、MOBI 或 AZW3 文件',
          existingBookId: null,
        },
      };
    });

    setItems((current) => [...current, ...additions]);
    pump();
  }

  function cancelItem(id: string) {
    const index = pending.current.findIndex((entry) => entry.id === id);
    if (index >= 0) {
      pending.current.splice(index, 1);
      outcome.current.failure += 1;
      updateItem(id, { status: 'cancelled' });
      return;
    }
    controllers.current.get(id)?.abort();
  }

  function handleInputChange(event: ChangeEvent<HTMLInputElement>) {
    const files = Array.from(event.target.files ?? []);
    // Reset so choosing the same file again still fires a change event.
    event.target.value = '';
    enqueue(files);
  }

  function handleDrop(event: DragEvent<HTMLDivElement>) {
    event.preventDefault();
    setDragging(false);
    enqueue(Array.from(event.dataTransfer.files ?? []));
  }

  const successful = items.filter((item) => item.status === 'done').length;
  const failed = items.filter((item) => item.status === 'error').length;
  const cancelled = items.filter((item) => item.status === 'cancelled').length;

  return (
    <Dialog
      open
      onClose={onClose}
      title="上传图书"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      <div className="flex max-h-[64vh] flex-col gap-4 overflow-y-auto pr-1">
        <div
          onDragOver={(event) => {
            event.preventDefault();
            setDragging(true);
          }}
          onDragLeave={() => setDragging(false)}
          onDrop={handleDrop}
          className={cn(
            'flex flex-col items-center gap-3 rounded-lg border border-dashed px-4 py-8 text-center transition',
            dragging ? 'border-accent bg-accent/5' : 'border-border bg-paper/40',
          )}
        >
          <p className="text-sm text-ink">把图书文件拖到这里</p>
          <p className="text-xs leading-5 text-muted">
            支持 PDF、EPUB、MOBI、AZW3，单本不超过 500 MB，最多同时上传 3 个。
          </p>
          <input
            id={inputId}
            type="file"
            multiple
            accept=".pdf,.epub,.mobi,.azw3"
            aria-label="选择文件"
            onChange={handleInputChange}
            className={cn(
              'text-xs text-muted file:mr-3 file:rounded-md file:border file:border-border',
              'file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-ink',
              'hover:file:bg-ink/5',
            )}
          />
        </div>

        {items.length > 0 ? (
          <>
            <p role="status" className="text-xs tracking-wide text-muted">
              共 {items.length} 个文件 · 成功 {successful} · 失败 {failed}
              {cancelled > 0 ? ` · 已取消 ${cancelled}` : ''}
            </p>
            <ul className="flex flex-col gap-3" aria-label="上传队列">
              {items.map((item) => (
                <li
                  key={item.id}
                  className="rounded-md border border-border bg-surface px-3 py-3"
                >
                  <div className="flex items-start justify-between gap-3">
                    <div className="min-w-0">
                      <p className="truncate text-sm text-ink" title={item.file.name}>
                        {item.file.name}
                      </p>
                      <p className="mt-0.5 text-xs text-muted">{formatBytes(item.file.size)}</p>
                    </div>
                    {isActive(item.status) ? (
                      <Button
                        variant="ghost"
                        size="sm"
                        onClick={() => cancelItem(item.id)}
                        aria-label={`取消上传《${item.file.name}》`}
                      >
                        取消
                      </Button>
                    ) : null}
                  </div>

                  <div
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={100}
                    aria-valuenow={item.progress}
                    aria-label={`${item.file.name} 上传进度`}
                    className="mt-2 h-1.5 overflow-hidden rounded-full bg-ink/10"
                  >
                    <div
                      className={cn(
                        'h-full rounded-full transition-[width] duration-200',
                        item.status === 'error' || item.status === 'cancelled'
                          ? 'bg-ink/20'
                          : 'bg-accent',
                      )}
                      style={{ width: `${item.progress}%` }}
                    />
                  </div>

                  <div className="mt-1.5 text-xs">
                    {item.status === 'queued' ? (
                      <p className="text-muted">等待上传</p>
                    ) : item.status === 'hashing' ? (
                      <p role="status" className="text-muted">
                        正在校验文件…
                      </p>
                    ) : item.status === 'uploading' ? (
                      <p className="text-muted">正在上传 {item.progress}%</p>
                    ) : item.status === 'done' ? (
                      <p className="text-accent">已完成</p>
                    ) : item.status === 'cancelled' ? (
                      <p className="text-muted">已取消</p>
                    ) : item.failure ? (
                      <div
                        role="alert"
                        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-highlight"
                      >
                        <span>{item.failure.message}</span>
                        {item.failure.kind === 'duplicate' &&
                        item.failure.existingBookId ? (
                          <Link
                            to={`/books/${item.failure.existingBookId}`}
                            onClick={onClose}
                            className="text-accent underline underline-offset-4 hover:text-accent/80 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
                          >
                            查看已有图书
                          </Link>
                        ) : null}
                      </div>
                    ) : null}
                  </div>
                </li>
              ))}
            </ul>
          </>
        ) : (
          <p className="text-xs leading-5 text-muted">
            上传后会先校验文件内容，同一本书不会重复占用书架空间。
          </p>
        )}
      </div>
    </Dialog>
  );
}
