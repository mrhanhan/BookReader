import { useCallback, useEffect, useState } from 'react';
import type { BookDto } from '@bookr/shared';
import { Button, Dialog, EmptyState } from '@bookr/ui';
import { useQueryClient } from '@tanstack/react-query';
import { Link } from 'react-router';
import { BOOKS_QUERY_KEY, useBooks, useDeleteBook } from '../../api/books';
import { useCategories } from '../../api/categories';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { formatBytes } from '../../lib/format';
import { BookCard } from './BookCard';
import { EditBookDialog } from './EditBookDialog';
import { DEFAULT_FILTERS, FilterBar } from './FilterBar';
import type { ShelfFilters, ShelfView } from './FilterBar';
import { Toast } from './Toast';
import { UploadDialog } from './UploadDialog';

const SHELF_VIEW_KEY = 'bookr.shelf.view';

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
  const [editingBook, setEditingBook] = useState<BookDto | null>(null);
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
  const dismissToast = useCallback(() => setToast(null), []);

  function changeView(next: ShelfView) {
    setView(next);
    try {
      localStorage.setItem(SHELF_VIEW_KEY, next);
    } catch {
      // Persisting the preference is best-effort.
    }
  }

  function closeDeleteDialog() {
    if (deleteBook.isPending) return;
    setDeletingBook(null);
    setDeleteError(null);
  }

  function confirmDelete() {
    if (!deletingBook) return;
    setDeleteError(null);
    deleteBook.mutate(deletingBook.id, {
      onSuccess: () => {
        setDeletingBook(null);
        setToast('已移入回收站');
      },
      onError: (error) => setDeleteError(messageForApiError(error)),
    });
  }

  const filtersActive = Boolean(
    filters.query.trim() ||
      filters.format ||
      filters.status ||
      filters.categoryId ||
      filters.sort !== DEFAULT_FILTERS.sort,
  );
  const quotaRatio =
    user && user.libraryQuotaBytes > 0 ? user.libraryUsedBytes / user.libraryQuotaBytes : 0;
  const nearingQuota = quotaRatio > 0.9;
  const isAdmin = user?.role === 'admin';
  const books = booksQuery.data?.items ?? [];
  const total = booksQuery.data?.total ?? 0;
  const totalPages = Math.max(1, Math.ceil(total / filters.pageSize));

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

      {booksQuery.isPending ? (
        <p role="status" className="py-16 text-center text-sm tracking-widest text-muted">
          正在整理书架…
        </p>
      ) : booksQuery.isError ? (
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
          {books.map((book) => (
            <BookCard
              key={book.id}
              book={book}
              view={view}
              canManage={Boolean(user && (user.role === 'admin' || book.uploadedBy.id === user.id))}
              onEdit={setEditingBook}
              onDelete={(selected) => {
                setDeleteError(null);
                setDeletingBook(selected);
              }}
            />
          ))}
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
          onClose={() => setEditingBook(null)}
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
