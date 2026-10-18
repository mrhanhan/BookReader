import { useCallback, useEffect, useMemo, useState } from 'react';
import type { BookDto } from '@bookr/shared';
import { Button, Dialog, cn } from '@bookr/ui';
import { useQueries } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { apiFetch } from '../../api/client';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { formatBytes } from '../../lib/format';
import { useOfflineSession } from '../../offline/offlineContext';
import type { OfflineBookRow } from '../../sync/types';

/**
 * Shows what this account keeps on the device and lets the reader pin, remove
 * or bulk-clear cached copies. Reading data (progress, notes, bookmarks) is
 * never touched here.
 */
export function OfflineCachePanel() {
  const { user } = useAuth();
  const userId = user?.id ?? null;
  const { db, cache } = useOfflineSession();

  const rows = useLiveQuery(
    () =>
      userId === null
        ? Promise.resolve([] as OfflineBookRow[])
        : db.offlineBooks.where('userId').equals(userId).toArray(),
    [db, userId],
  );

  // Pinned placeholders without bytes are download intents, not cached books.
  const cachedRows = useMemo(
    () =>
      [...(rows ?? [])]
        .filter((row) => row.bytes > 0)
        .sort(
          (left, right) =>
            right.lastReadAt - left.lastReadAt || left.bookId.localeCompare(right.bookId),
        ),
    [rows],
  );
  const cachedIds = useMemo(() => cachedRows.map((row) => row.bookId), [cachedRows]);

  const [usage, setUsage] = useState<{ bytes: number; quota: number | null } | null>(null);
  const rowsFingerprint = cachedRows
    .map((row) => `${row.bookId}:${row.bytes}:${row.pinned ? 1 : 0}`)
    .join('|');

  useEffect(() => {
    if (userId === null) {
      setUsage(null);
      return;
    }

    let cancelled = false;
    cache
      .usage(userId)
      .then((value) => {
        if (!cancelled) setUsage({ bytes: value.bytes, quota: value.quota });
      })
      .catch(() => {
        if (!cancelled) setUsage(null);
      });
    return () => {
      cancelled = true;
    };
  }, [cache, userId, rowsFingerprint]);

  // Titles live on the server; the cached bytes only know their book ids.
  const titleQueries = useQueries({
    queries: cachedIds.map((bookId) => ({
      queryKey: ['book', bookId] as const,
      queryFn: async () => {
        const result = await apiFetch<{ book: BookDto }>(
          `/api/books/${encodeURIComponent(bookId)}`,
        );
        return result.book;
      },
    })),
  });

  const bookLabels = useMemo(() => {
    const labels = new Map<string, { title: string | null; failed: boolean }>();
    cachedIds.forEach((bookId, index) => {
      const query = titleQueries[index];
      labels.set(bookId, {
        title: query?.data?.title ?? null,
        failed: query?.isError === true,
      });
    });
    return labels;
  }, [cachedIds, titleQueries]);

  const labelFor = useCallback(
    (bookId: string): string => {
      const entry = bookLabels.get(bookId);
      if (entry?.title) return entry.title;
      return entry?.failed ? '未知图书' : '正在读取书名…';
    },
    [bookLabels],
  );

  const [busyBookId, setBusyBookId] = useState<string | null>(null);
  const [feedback, setFeedback] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [clearing, setClearing] = useState(false);

  const unpinnedCount = cachedRows.filter((row) => !row.pinned).length;

  async function togglePinned(row: OfflineBookRow) {
    if (userId === null) return;
    const title = labelFor(row.bookId);
    setBusyBookId(row.bookId);
    setError(null);
    try {
      if (row.pinned) {
        await cache.unpin(userId, row.bookId);
        setFeedback(`《${title}》已取消固定`);
      } else {
        await cache.pin(userId, row.bookId);
        setFeedback(`《${title}》已固定，不会被自动清理`);
      }
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setBusyBookId(null);
    }
  }

  async function removeBook(row: OfflineBookRow) {
    if (userId === null) return;
    const title = labelFor(row.bookId);
    setBusyBookId(row.bookId);
    setError(null);
    try {
      await cache.remove(userId, row.bookId);
      setFeedback(`《${title}》已移出本机`);
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setBusyBookId(null);
    }
  }

  async function clearUnpinnedCaches() {
    if (userId === null) return;
    setClearing(true);
    setError(null);
    try {
      const removed = await cache.clearUnpinned(userId);
      setConfirmClear(false);
      setFeedback(
        removed.length === 0
          ? '没有可清理的未固定缓存'
          : `已清理 ${removed.length} 本未固定的缓存`,
      );
    } catch (caught) {
      setError(messageForApiError(caught));
    } finally {
      setClearing(false);
    }
  }

  const usedBytes =
    usage?.bytes ?? cachedRows.reduce((total, row) => total + row.bytes, 0);

  return (
    <section
      aria-labelledby="settings-offline-title"
      className="rounded-lg border border-border bg-surface/80 p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="settings-offline-title" className="font-serif text-lg text-ink">
            离线缓存
          </h2>
          <p className="mt-1 text-xs text-muted">
            下载到本机的书籍可以离线阅读；固定后不会被自动清理。
          </p>
        </div>
        <Button
          variant="ghost"
          size="sm"
          disabled={unpinnedCount === 0}
          onClick={() => setConfirmClear(true)}
        >
          清理未固定的缓存
        </Button>
      </div>

      <p className="mt-4 text-sm text-muted">
        已用 {formatBytes(usedBytes)}
        {usage?.quota != null
          ? ` / ${formatBytes(usage.quota)}`
          : '（本机配额未知）'}
      </p>

      {feedback ? (
        <p role="status" aria-live="polite" className="mt-2 text-xs text-accent">
          {feedback}
        </p>
      ) : null}
      {error ? (
        <p role="alert" className="mt-2 text-xs text-highlight">
          {error}
        </p>
      ) : null}

      {cachedRows.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
          还没有缓存任何书籍。在书架上选择“下载到本机”即可离线阅读。
        </p>
      ) : (
        <ul aria-label="已缓存的书籍" className="mt-3 divide-y divide-border">
          {cachedRows.map((row) => {
            const title = labelFor(row.bookId);
            const busy = busyBookId === row.bookId;
            return (
              <li
                key={row.bookId}
                className="flex flex-wrap items-center justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="truncate text-sm text-ink" title={title}>
                    {title}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">{formatBytes(row.bytes)}</p>
                </div>
                <div className="flex items-center gap-2">
                  <button
                    type="button"
                    role="switch"
                    aria-checked={row.pinned}
                    aria-label={`固定《${title}》`}
                    disabled={busy}
                    onClick={() => void togglePinned(row)}
                    className={cn(
                      'relative h-5 w-9 shrink-0 rounded-full transition',
                      'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
                      'disabled:cursor-not-allowed disabled:opacity-60',
                      row.pinned ? 'bg-accent' : 'bg-border',
                    )}
                  >
                    <span
                      aria-hidden="true"
                      className={cn(
                        'absolute top-0.5 size-4 rounded-full bg-paper shadow-sm transition',
                        row.pinned ? 'left-[1.125rem]' : 'left-0.5',
                      )}
                    />
                  </button>
                  <span className="w-12 text-xs text-muted">
                    {row.pinned ? '已固定' : '固定'}
                  </span>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`将《${title}》移出本机`}
                    disabled={busy}
                    onClick={() => void removeBook(row)}
                  >
                    移出
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {confirmClear ? (
        <Dialog
          open
          onClose={() => {
            if (!clearing) setConfirmClear(false);
          }}
          title="清理未固定的缓存"
          footer={
            <>
              <Button
                variant="ghost"
                disabled={clearing}
                onClick={() => setConfirmClear(false)}
              >
                取消
              </Button>
              <Button variant="danger" loading={clearing} onClick={() => void clearUnpinnedCaches()}>
                确认清理
              </Button>
            </>
          }
        >
          <p className="text-sm leading-6 text-ink">
            将移出 {unpinnedCount} 本未固定的书籍。已固定的书籍和所有阅读记录都会保留。
          </p>
        </Dialog>
      ) : null}
    </section>
  );
}
