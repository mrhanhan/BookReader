import { useCallback, useContext, useEffect, useMemo, useState } from 'react';
import type { BookDto } from '@bookr/shared';
import { Button, Dialog, EmptyState } from '@bookr/ui';
import { useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { Link } from 'react-router';
import { BOOKS_QUERY_KEY, useBooks, useDeleteBook, useRetryConversion } from '../../api/books';
import { useCategories } from '../../api/categories';
import { fetchReaderFile } from '../../api/reading';
import { fetchReflowFile } from '../../api/reflow';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { formatBytes } from '../../lib/format';
import { cacheKey } from '../../offline/fileStore';
import { useOfflineSession } from '../../offline/offlineContext';
import { bookFromShelfSnapshot, shelfSnapshotOf } from '../../offline/shelfSnapshot';
import { SyncContext } from '../../sync/SyncProvider';
import type { CachedShelfBook, OfflineBookRow } from '../../sync/types';
import { BookCard } from './BookCard';
import { EditBookDialog } from './EditBookDialog';
import { DEFAULT_FILTERS, FilterBar } from './FilterBar';
import type { ShelfFilters, ShelfView } from './FilterBar';
import { Toast } from './Toast';
import { UploadDialog } from './UploadDialog';

const SHELF_VIEW_KEY = 'bookr.shelf.view';

/** Absence of an offline signal counts as online, as jsdom reports. */
function isOnlineNow(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
}

function readShelfView(): ShelfView {
  try {
    return localStorage.getItem(SHELF_VIEW_KEY) === 'list' ? 'list' : 'grid';
  } catch {
    // Blocked storage behaves like the default grid.
    return 'grid';
  }
}

/** The shared family shelf: search, filters, quiet cards and editing. */
export function BookshelfPage() {
  const { user } = useAuth();
  const [filters, setFilters] = useState<ShelfFilters>(DEFAULT_FILTERS);
  const [view, setView] = useState<ShelfView>(readShelfView);
  const [editingBookId, setEditingBookId] = useState<string | null>(null);
  const [editSnapshot, setEditSnapshot] = useState<BookDto | null>(null);
  const [deletingBook, setDeletingBook] = useState<BookDto | null>(null);
  const [deleteError, setDeleteError] = useState<string | null>(null);
  const [toast, setToast] = useState<string | null>(null);
  const [uploadOpen, setUploadOpen] = useState(false);
  const queryClient = useQueryClient();

  const booksQuery = useBooks({
    query: filters.query,
    format: filters.format || undefined,
    status: filters.status || undefined,
    categoryId: filters.categoryId || undefined,
    sort: filters.sort,
    page: filters.page,
    pageSize: filters.pageSize,
  });
  const categoriesQuery = useCategories();
  const deleteBook = useDeleteBook();
  const retryConversion = useRetryConversion();
  const dismissToast = useCallback(() => setToast(null), []);
  const { db, store, cache } = useOfflineSession();
  // The shelf lives outside `SyncProvider` in some tests, so read the context
  // directly rather than through `useSync`, which requires a provider.
  const sync = useContext(SyncContext);
  const userId = user?.id ?? null;
  const online = isOnlineNow();
  // Local cache writes arrive through the live query; a finished sync cycle can
  // also change what this account has on the device.
  const offlineRows = useLiveQuery(
    () =>
      userId === null
        ? Promise.resolve([] as OfflineBookRow[])
        : db.offlineBooks.where('userId').equals(userId).toArray(),
    [db, userId, sync?.state.lastSyncedAt],
  );
  const offlineByBook = useMemo(
    () => new Map((offlineRows ?? []).map((row) => [row.bookId, row])),
    [offlineRows],
  );
  const [offlinePending, setOfflinePending] = useState<ReadonlySet<string>>(new Set());
  // `bytes > 0` is only a hint: the badge must mean the original file is
  // actually readable, which only the store can answer.
  const [cachedFileIds, setCachedFileIds] = useState<ReadonlySet<string>>(new Set());
  const cachedShelfRows = useLiveQuery(
    async () => {
      if (userId === null) return [] as CachedShelfBook[];
      const rows = await db.shelf.where('userId').equals(userId).toArray();
      // Newest metadata first, mirroring the default server sort.
      return rows.sort((left, right) => right.updatedAt.localeCompare(left.updatedAt));
    },
    [db, userId, sync?.state.lastSyncedAt],
  );

  useEffect(() => {
    if (userId === null || offlineRows === undefined) return;
    let cancelled = false;
    void (async () => {
      const present = new Set<string>();
      for (const row of offlineRows) {
        const exists = await store
          .has(cacheKey(userId, row.bookId, 'book'))
          .catch(() => false);
        if (exists) present.add(row.bookId);
      }
      if (!cancelled) setCachedFileIds(present);
    })();
    return () => {
      cancelled = true;
    };
  }, [offlineRows, store, userId]);

  const markOfflinePending = useCallback((bookId: string, pending: boolean) => {
    setOfflinePending((current) => {
      const next = new Set(current);
      if (pending) next.add(bookId);
      else next.delete(bookId);
      return next;
    });
  }, []);

  /** Keeps the book and its reflow pack on this device, and pins them. */
  async function downloadBook(book: BookDto) {
    if (!userId) return;
    markOfflinePending(book.id, true);
    const wasPinned = await cache.isPinned(userId, book.id).catch(() => false);
    try {
      await cache.pin(userId, book.id);
      const file = await fetchReaderFile(book.id);
      await cache.cacheFromUrl(userId, book.id, 'book', file.url);
      if (book.reflowAvailable) {
        // The pack is optional: the original document is already readable.
        const reflow = await fetchReflowFile(book.id).catch(() => null);
        if (reflow) await cache.cacheFromUrl(userId, book.id, 'reflow', reflow.url);
      }
      await cache.enforceLru(userId, book.id);
      setToast(`《${book.title}》已下载到本机，可离线阅读`);
    } catch {
      // Do not leave a pinned placeholder behind when the download never landed.
      if (!wasPinned) await cache.unpin(userId, book.id).catch(() => undefined);
      setToast('下载失败，请检查网络后重试');
    } finally {
      markOfflinePending(book.id, false);
    }
  }

  async function unpinBook(book: BookDto) {
    if (!userId) return;
    markOfflinePending(book.id, true);
    try {
      await cache.unpin(userId, book.id);
      setToast(`《${book.title}》已取消固定`);
    } catch {
      setToast('操作失败，请稍后重试');
    } finally {
      markOfflinePending(book.id, false);
    }
  }

  /** Removes the downloaded copy only; notes, bookmarks and progress stay. */
  async function removeBookFromDevice(book: BookDto) {
    if (!userId) return;
    markOfflinePending(book.id, true);
    try {
      await cache.remove(userId, book.id);
      setToast(`《${book.title}》已移出本机`);
    } catch {
      setToast('操作失败，请稍后重试');
    } finally {
      markOfflinePending(book.id, false);
    }
  }

  function changeView(next: ShelfView) {
    setView(next);
    try {
      localStorage.setItem(SHELF_VIEW_KEY, next);
    } catch {
      // Persisting the preference is best-effort.
    }
  }

  function openEditDialog(book: BookDto) {
    setEditSnapshot(book);
    setEditingBookId(book.id);
  }

  function closeEditDialog() {
    setEditingBookId(null);
    setEditSnapshot(null);
  }

  function closeDeleteDialog() {
    if (deleteBook.isPending) return;
    setDeletingBook(null);
    setDeleteError(null);
  }

  function confirmDelete() {
    if (!deletingBook) return;
    const target = deletingBook;
    setDeleteError(null);
    deleteBook.mutate(target.id, {
      onSuccess: () => {
        // Drop the snapshot immediately; the next full load would prune it too.
        if (userId) void db.shelf.delete([userId, target.id]).catch(() => undefined);
        setDeletingBook(null);
        setToast('已移入回收站');
      },
      onError: (error) => setDeleteError(messageForApiError(error)),
    });
  }

  function retryBookConversion(book: BookDto) {
    retryConversion.mutate(book.id, {
      onSuccess: () => setToast(`已重新开始转换《${book.title}》`),
      onError: (error) => setToast(messageForApiError(error)),
    });
  }

  const filtersActive = Boolean(
    filters.query.trim() ||
      filters.format ||
      filters.status ||
      filters.categoryId ||
      filters.sort !== DEFAULT_FILTERS.sort,
  );

  // Every successful shelf load refreshes the on-device snapshot used when the
  // library API is unreachable. Only the `CachedShelfBook` fields are stored.
  // A complete, unfiltered first page is the whole truth for this account, so
  // rows missing from it (deleted or trashed elsewhere) are pruned.
  useEffect(() => {
    const data = booksQuery.data;
    if (!data || userId === null) return;
    const items = data.items;
    const completeShelf = !filtersActive && data.page === 1 && data.total <= data.pageSize;
    let cancelled = false;

    void (async () => {
      try {
        if (cancelled) return;
        if (items.length > 0) {
          await db.shelf.bulkPut(items.map((item) => shelfSnapshotOf(item, userId)));
        }
        // A newer load owns the snapshot now; its own pass prunes.
        if (cancelled || !completeShelf) return;
        const keep = new Set(items.map((item) => item.id));
        const existing = await db.shelf.where('userId').equals(userId).toArray();
        if (cancelled) return;
        const stale = existing
          .filter((row) => !keep.has(row.id))
          .map((row) => [userId, row.id] as [string, string]);
        if (stale.length > 0) await db.shelf.bulkDelete(stale);
      } catch {
        // The snapshot is best-effort; reading still falls back to the API.
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [booksQuery.data, db, filtersActive, userId]);
  const quotaRatio =
    user && user.libraryQuotaBytes > 0 ? user.libraryUsedBytes / user.libraryQuotaBytes : 0;
  const nearingQuota = quotaRatio > 0.9;
  const isAdmin = user?.role === 'admin';
  // Offline, or after a failed library request, the shelf falls back to the
  // metadata snapshot so books downloaded to this device stay openable.
  const fallbackBooks = cachedShelfRows
    ?.filter((row) => row.deletedAt == null)
    .map(bookFromShelfSnapshot);
  const usingCachedShelf =
    booksQuery.data === undefined &&
    fallbackBooks !== undefined &&
    (booksQuery.isError || !online);
  const books = booksQuery.data?.items ?? (usingCachedShelf ? (fallbackBooks ?? []) : []);
  const total = booksQuery.data?.total ?? (usingCachedShelf ? books.length : 0);
  const totalPages = usingCachedShelf ? 1 : Math.max(1, Math.ceil(total / filters.pageSize));

  // Prefer the refetched shelf entry so a reflow upload/removal is visible when
  // the dialog is reopened; the snapshot only covers a book filtered off-page.
  const editingBook =
    (editingBookId ? books.find((item) => item.id === editingBookId) : undefined) ??
    (editSnapshot && editSnapshot.id === editingBookId ? editSnapshot : null);

  // Deleting the last book on a trailing page leaves the shelf past its end.
  useEffect(() => {
    if (!booksQuery.data) return;
    const lastPage = Math.max(1, Math.ceil(booksQuery.data.total / filters.pageSize));
    if (filters.page > lastPage) {
      setFilters((current) => ({ ...current, page: lastPage }));
    }
  }, [booksQuery.data, filters.page, filters.pageSize]);

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-end justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-ink">书架</h1>
          <p className="mt-1 text-sm text-muted">和家人共享的藏书都在这里。</p>
        </div>
        <div className="flex items-center gap-3">
          {booksQuery.data ? (
            <p className="text-xs tracking-widest text-muted">共 {booksQuery.data.total} 本</p>
          ) : null}
          <Button onClick={() => setUploadOpen(true)}>上传图书</Button>
        </div>
      </div>

      {nearingQuota && user ? (
        <div
          role="status"
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-4 py-3"
        >
          <div>
            <p className="text-sm font-medium text-highlight">
              {isAdmin ? '书库空间即将用尽' : '共享书库空间即将用尽，请联系管理员'}
            </p>
            <p className="mt-0.5 text-xs text-muted">
              已使用 {formatBytes(user.libraryUsedBytes)} / {formatBytes(user.libraryQuotaBytes)}
            </p>
          </div>
          {isAdmin ? (
            <Link
              to="/admin/members"
              className="text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              查看存储用量
            </Link>
          ) : null}
        </div>
      ) : null}

      <FilterBar
        filters={filters}
        categories={categoriesQuery.data ?? []}
        view={view}
        onChange={setFilters}
        onViewChange={changeView}
      />

      {usingCachedShelf && books.length > 0 ? (
        <p role="status" className="text-xs tracking-widest text-muted">
          当前离线，显示本机缓存的书架。
        </p>
      ) : null}

      {usingCachedShelf && books.length === 0 ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-5 py-10 text-center"
        >
          <p className="text-sm text-highlight">当前离线，书架也还没有同步到本机。</p>
          <Button variant="ghost" size="sm" onClick={() => void booksQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : booksQuery.isPending && !usingCachedShelf ? (
        <p role="status" className="py-16 text-center text-sm tracking-widest text-muted">
          正在整理书架…
        </p>
      ) : booksQuery.isError && !usingCachedShelf ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-5 py-10 text-center"
        >
          <p className="text-sm text-highlight">{messageForApiError(booksQuery.error)}</p>
          <Button variant="ghost" size="sm" onClick={() => booksQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : books.length === 0 ? (
        filtersActive ? (
          <EmptyState
            title="没有找到匹配的图书"
            description="换个关键词，或清除筛选后再看看。"
            action={
              <Button variant="ghost" onClick={() => setFilters(DEFAULT_FILTERS)}>
                清除筛选
              </Button>
            }
          />
        ) : (
          <EmptyState
            title="书架还是空的"
            description="上传第一本书，和家里人一起读。"
            action={<Button onClick={() => setUploadOpen(true)}>上传第一本书</Button>}
          />
        )
      ) : (
        <div
          className={
            view === 'grid'
              ? 'grid grid-cols-2 gap-4 sm:grid-cols-3 lg:grid-cols-4'
              : 'flex flex-col gap-3'
          }
        >
          {books.map((book) => {
            const row = offlineByBook.get(book.id);
            return (
              <BookCard
                key={book.id}
                book={book}
                view={view}
                canManage={Boolean(
                  user && (user.role === 'admin' || book.uploadedBy.id === user.id),
                )}
                onEdit={openEditDialog}
                onDelete={(selected) => {
                  setDeleteError(null);
                  setDeletingBook(selected);
                }}
                onRetryConversion={retryBookConversion}
                retryPending={retryConversion.isPending}
                offline={
                  userId === null
                    ? undefined
                    : {
                        cached: cachedFileIds.has(book.id),
                        pinned: row?.pinned === true,
                        pending: offlinePending.has(book.id),
                      }
                }
                onDownload={(selected) => void downloadBook(selected)}
                onUnpin={(selected) => void unpinBook(selected)}
                onRemoveOffline={(selected) => void removeBookFromDevice(selected)}
              />
            );
          })}
        </div>
      )}

      {!booksQuery.isPending && !booksQuery.isError && books.length > 0 && totalPages > 1 ? (
        <nav aria-label="书架分页" className="flex items-center justify-center gap-4 pt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={filters.page <= 1}
            onClick={() => setFilters({ ...filters, page: filters.page - 1 })}
          >
            上一页
          </Button>
          <p className="text-xs tracking-widest text-muted">
            第 {filters.page} / {totalPages} 页
          </p>
          <Button
            variant="ghost"
            size="sm"
            disabled={filters.page >= totalPages}
            onClick={() => setFilters({ ...filters, page: filters.page + 1 })}
          >
            下一页
          </Button>
        </nav>
      ) : null}

      {editingBook ? (
        <EditBookDialog
          key={editingBook.id}
          book={editingBook}
          onClose={closeEditDialog}
        />
      ) : null}

      <Dialog
        open={deletingBook !== null}
        onClose={closeDeleteDialog}
        title="删除图书"
        footer={
          <>
            <Button variant="ghost" onClick={closeDeleteDialog} disabled={deleteBook.isPending}>
              取消
            </Button>
            <Button variant="danger" onClick={confirmDelete} loading={deleteBook.isPending}>
              确认删除
            </Button>
          </>
        }
      >
        <div className="flex flex-col gap-3">
          <p className="text-sm leading-6 text-ink">
            确定要把《{deletingBook?.title}》移入回收站吗？30 天内可以恢复。
          </p>
          {deleteError ? (
            <p
              role="alert"
              className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
            >
              {deleteError}
            </p>
          ) : null}
        </div>
      </Dialog>

      {uploadOpen ? (
        <UploadDialog
          onClose={() => setUploadOpen(false)}
          onUploaded={() => {
            void queryClient.invalidateQueries({ queryKey: BOOKS_QUERY_KEY });
            setToast('上传完成');
          }}
        />
      ) : null}

      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </section>
  );
}
