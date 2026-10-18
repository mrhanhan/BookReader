import type { BookDto } from '@bookr/shared';
import { Button, cn } from '@bookr/ui';
import { Link } from 'react-router';
import { formatDate } from '../../lib/format';
import type { ShelfView } from './FilterBar';
import {
  CONVERSION_LABELS,
  FORMAT_LABELS,
  STATUS_LABELS,
  canRetryConversion,
} from './labels';

export interface BookCardProps {
  book: BookDto;
  view: ShelfView;
  canManage: boolean;
  onEdit: (book: BookDto) => void;
  onDelete: (book: BookDto) => void;
  /** Queues another conversion attempt; only managers see the action. */
  onRetryConversion?: (book: BookDto) => void;
  retryPending?: boolean;
}

/** One shelf entry: cover or paper placeholder, metadata, progress and actions. */
export function BookCard({
  book,
  view,
  canManage,
  onEdit,
  onDelete,
  onRetryConversion,
  retryPending = false,
}: BookCardProps) {
  const progress = Math.max(0, Math.min(100, Math.round(book.progressPercent)));
  const isGrid = view === 'grid';

  return (
    <article
      data-testid="book-card"
      className={cn(
        'group overflow-hidden rounded-lg border border-border bg-surface/80 transition',
        'hover:border-accent/30 hover:shadow-sm',
        isGrid ? 'flex flex-col' : 'flex gap-4 p-3',
      )}
    >
      <div
        className={cn(
          'relative shrink-0 overflow-hidden bg-paper',
          isGrid
            ? 'aspect-[3/4] w-full border-b border-border'
            : 'h-28 w-20 rounded-md border border-border',
        )}
      >
        {book.coverUrl ? (
          <img
            src={book.coverUrl}
            alt={`《${book.title}》封面`}
            loading="lazy"
            className="h-full w-full object-cover"
          />
        ) : (
          <div
            aria-hidden="true"
            className="flex h-full w-full flex-col items-center justify-center gap-3 px-3 text-center"
          >
            <span className="font-serif text-3xl text-accent/50">{book.title.slice(0, 1)}</span>
            <span className="h-px w-8 bg-border" />
            <span className="h-10 w-1.5 rounded-full bg-border/70" />
          </div>
        )}
      </div>

      <div className={cn('flex min-w-0 flex-1 flex-col gap-2', isGrid ? 'p-4' : 'py-0.5 pr-1')}>
        <div className="flex items-start justify-between gap-2">
          <div className="min-w-0">
            <h3 className="truncate font-serif text-base leading-6 text-ink" title={book.title}>
              {book.title}
            </h3>
            <p className="truncate text-sm text-muted">{book.author ?? '佚名'}</p>
          </div>
          <span className="shrink-0 rounded-sm border border-border px-1.5 py-0.5 text-[10px] tracking-wider text-muted">
            {FORMAT_LABELS[book.format]}
          </span>
        </div>

        <p className="truncate text-xs text-muted">
          由 {book.uploadedBy.displayName} 上传 · {formatDate(book.createdAt)}
        </p>

        {book.categories.length > 0 ? (
          <ul aria-label="分类" className="flex flex-wrap gap-1.5">
            {book.categories.map((category) => (
              <li
                key={category.id}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted"
              >
                <span
                  aria-hidden="true"
                  className="size-1.5 rounded-full"
                  style={{ backgroundColor: category.color }}
                />
                {category.name}
              </li>
            ))}
          </ul>
        ) : null}

        {book.conversionStatus !== 'none' ? (
          <div className="flex flex-wrap items-center gap-2 text-[11px]">
            <span
              className={cn(
                'rounded-sm border px-1.5 py-0.5',
                book.conversionStatus === 'failed'
                  ? 'border-highlight/40 text-highlight'
                  : 'border-border text-muted',
              )}
            >
              {CONVERSION_LABELS[book.conversionStatus]}
            </span>
            {book.conversionStatus === 'failed' && book.conversionError ? (
              <span className="min-w-0 truncate text-muted" title={book.conversionError}>
                {book.conversionError}
              </span>
            ) : null}
            {canManage &&
            canRetryConversion(book.conversionStatus) &&
            onRetryConversion ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`重试转换《${book.title}》`}
                disabled={retryPending}
                onClick={() => onRetryConversion(book)}
              >
                重试转换
              </Button>
            ) : null}
          </div>
        ) : null}

        <div className="mt-auto flex items-center gap-2 pt-1">
          <span className="shrink-0 text-[11px] tracking-wide text-muted">
            {STATUS_LABELS[book.status]}
          </span>
          <div
            role="progressbar"
            aria-label={`《${book.title}》阅读进度`}
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            className="h-1 min-w-12 flex-1 overflow-hidden rounded-full bg-border/70"
          >
            <div
              className="h-full rounded-full bg-accent/70 transition-all"
              style={{ width: `${progress}%` }}
            />
          </div>
          <span className="w-8 shrink-0 text-right text-[11px] tabular-nums text-muted">
            {progress}%
          </span>
        </div>

        <div className="flex items-center gap-2 pt-0.5">
          <Link
            to={`/books/${book.id}/read`}
            aria-label={`阅读《${book.title}》`}
            className="rounded-md px-2 py-1 text-sm text-accent transition hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            阅读
          </Link>
          {canManage ? (
            <>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`编辑《${book.title}》`}
                onClick={() => onEdit(book)}
              >
                编辑
              </Button>
              <Button
                variant="ghost"
                size="sm"
                aria-label={`删除《${book.title}》`}
                onClick={() => onDelete(book)}
              >
                删除
              </Button>
            </>
          ) : null}
        </div>
      </div>
    </article>
  );
}
