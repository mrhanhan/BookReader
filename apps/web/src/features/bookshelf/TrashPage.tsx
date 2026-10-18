import { useCallback, useState } from 'react';
import { Button, EmptyState } from '@bookr/ui';
import { useRestoreBook, useTrash } from '../../api/books';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { TRASH_RETENTION_DAYS, formatBytes, formatDate, retentionDaysLeft } from '../../lib/format';
import { FORMAT_LABELS } from './labels';
import { Toast } from './Toast';

/** Trashed books, their remaining retention window and a restore action. */
export function TrashPage() {
  const { user } = useAuth();
  const trashQuery = useTrash();
  const restoreBook = useRestoreBook();
  const [toast, setToast] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const dismissToast = useCallback(() => setToast(null), []);

  function restore(id: string) {
    setError(null);
    restoreBook.mutate(id, {
      onSuccess: () => setToast('已恢复到书架'),
      onError: (cause) => setError(messageForApiError(cause)),
    });
  }

  const books = trashQuery.data ?? [];

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-2xl text-ink">回收站</h1>
        <p className="mt-1 text-sm text-muted">
          删除的书籍会保留 {TRASH_RETENTION_DAYS} 天，之后自动清理。
        </p>
      </div>

      {error ? (
        <p
          role="alert"
          className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
        >
          {error}
        </p>
      ) : null}

      {trashQuery.isPending ? (
        <p role="status" className="py-16 text-center text-sm tracking-widest text-muted">
          正在翻开回收站…
        </p>
      ) : trashQuery.isError ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-5 py-10 text-center"
        >
          <p className="text-sm text-highlight">{messageForApiError(trashQuery.error)}</p>
          <Button variant="ghost" size="sm" onClick={() => trashQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : books.length === 0 ? (
        <EmptyState title="回收站是空的" description="目前没有被删除的书籍。" />
      ) : (
        <ul className="flex flex-col gap-3">
          {books.map((book) => {
            // The API does not expose `deletedAt`; soft delete sets `updatedAt`
            // to the same instant, and trashed books accept no further updates.
            const daysLeft = retentionDaysLeft(book.updatedAt);
            const canManage = Boolean(
              user && (user.role === 'admin' || book.uploadedBy.id === user.id),
            );
            const restoring = restoreBook.isPending && restoreBook.variables === book.id;

            return (
              <li
                key={book.id}
                data-testid="trash-item"
                className="flex flex-wrap items-center gap-4 rounded-lg border border-border bg-surface/70 p-4"
              >
                <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-paper">
                  {book.coverUrl ? (
                    <img
                      src={book.coverUrl}
                      alt={`《${book.title}》封面`}
                      className="h-full w-full object-cover"
                    />
                  ) : (
                    <span aria-hidden="true" className="font-serif text-lg text-accent/50">
                      {book.title.slice(0, 1)}
                    </span>
                  )}
                </div>

                <div className="min-w-0 flex-1">
                  <h2 className="truncate font-serif text-base text-ink">{book.title}</h2>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    {book.author ?? '佚名'} · {FORMAT_LABELS[book.format]} ·{' '}
                    {formatBytes(book.size)}
                  </p>
                  <p className="mt-0.5 truncate text-xs text-muted">
                    由 {book.uploadedBy.displayName} 上传 · 删除于 {formatDate(book.updatedAt)}
                  </p>
                </div>

                <div className="flex shrink-0 flex-col items-end gap-1.5">
                  <p className={daysLeft <= 3 ? 'text-xs text-highlight' : 'text-xs text-muted'}>
                    {daysLeft === 0 ? '即将清理' : `剩余 ${daysLeft} 天`}
                  </p>
                  {canManage ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      aria-label={`恢复《${book.title}》`}
                      loading={restoring}
                      onClick={() => restore(book.id)}
                    >
                      恢复
                    </Button>
                  ) : (
                    <span className="text-xs text-muted">仅上传者可恢复</span>
                  )}
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
    </section>
  );
}
