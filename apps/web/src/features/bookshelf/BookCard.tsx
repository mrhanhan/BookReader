import type { ReactNode } from 'react';
import type { BookDto } from '@bookr/shared';
import { Button, cn } from '@bookr/ui';
import { Link } from 'react-router';
import { DownloadIcon, PencilIcon, PinIcon, TrashIcon, UnpinIcon } from '../../components/icons';
import { formatDate } from '../../lib/format';
import type { ShelfView } from './FilterBar';
import {
  CONVERSION_LABELS,
  FORMAT_LABELS,
  REFLOW_BADGE_LABEL,
  STATUS_LABELS,
  canRetryConversion,
} from './labels';

export interface BookOfflineState {
  /** A downloaded copy is stored for this account. */
  cached: boolean;
  /** The copy is pinned, so the LRU eviction never removes it. */
  pinned: boolean;
  /** A download, pin or removal request is running. */
  pending: boolean;
}

export interface BookCardProps {
  book: BookDto;
  view: ShelfView;
  canManage: boolean;
  onEdit: (book: BookDto) => void;
  onDelete: (book: BookDto) => void;
  /** Queues another conversion attempt; only managers see the action. */
  onRetryConversion?: (book: BookDto) => void;
  retryPending?: boolean;
  /** Offline state for the signed-in account; omitted while no one is signed in. */
  offline?: BookOfflineState;
  onDownload?: (book: BookDto) => void;
  onUnpin?: (book: BookDto) => void;
  onRemoveOffline?: (book: BookDto) => void;
}

/** Small icon action layered over the cover; kept visible on touch devices. */
function CoverAction({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled?: boolean;
  onClick: () => void;
  children: ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon"
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={onClick}
      className={cn(
        'border-border/80 bg-surface/95 text-ink shadow-sm backdrop-blur',
        // Desktop reveals the rail on hover; touch and keyboard users always see it.
        'sm:opacity-0 sm:group-hover:opacity-100 sm:group-focus-within:opacity-100',
      )}
    >
      {children}
    </Button>
  );
}

/**
 * One shelf entry. The cover carries the reading progress and offline actions;
 * the bottom fore-edge rail keeps only the primary action plus management.
 */
export function BookCard({
  book,
  view,
  canManage,
  onEdit,
  onDelete,
  onRetryConversion,
  retryPending = false,
  offline,
  onDownload,
  onUnpin,
  onRemoveOffline,
}: BookCardProps) {
  const progress = Math.max(0, Math.min(100, Math.round(book.progressPercent)));
  const isGrid = view === 'grid';

  return (
    <article
      data-testid="book-card"
      className={cn(
        'group flex overflow-hidden rounded-lg border border-border bg-surface/80 transition',
        'hover:border-accent/30 hover:shadow-sm',
        isGrid ? 'flex-col' : 'flex-row gap-3 p-3',
      )}
    >
      <div
        className={cn(
          'relative shrink-0 overflow-hidden bg-paper',
          isGrid
            ? 'aspect-[3/4] w-full border-b border-border'
            : 'h-32 w-24 self-center rounded-md border border-border',
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
            className="flex h-full w-full flex-col items-center justify-center gap-2 px-3 text-center"
          >
            <span className="font-serif text-4xl text-accent/55">{book.title.slice(0, 1)}</span>
            <span className="h-px w-8 bg-border" />
            <span className="line-clamp-2 text-[10px] tracking-[0.18em] text-muted/80">
              {book.author ?? '佚名'}
            </span>
          </div>
        )}

        <div className="absolute right-1.5 top-1.5 flex flex-col gap-1">
          {offline && onDownload && !offline.pinned ? (
            <CoverAction
              label={`下载到本机《${book.title}》`}
              disabled={offline.pending}
              onClick={() => onDownload(book)}
            >
              <DownloadIcon />
            </CoverAction>
          ) : null}
          {offline?.pinned && onUnpin ? (
            <CoverAction
              label={`取消固定《${book.title}》`}
              disabled={offline.pending}
              onClick={() => onUnpin(book)}
            >
              <UnpinIcon />
            </CoverAction>
          ) : null}
          {offline?.cached && onRemoveOffline ? (
            <CoverAction
              label={`移出本机《${book.title}》`}
              disabled={offline.pending}
              onClick={() => onRemoveOffline(book)}
            >
              <TrashIcon />
            </CoverAction>
          ) : null}
        </div>

        <div className="absolute bottom-1.5 left-1.5 flex flex-wrap gap-1">
          {offline?.pinned ? (
            <span className="inline-flex items-center gap-1 rounded-sm border border-accent/40 bg-surface/90 px-1.5 py-0.5 text-[10px] tracking-wider text-accent backdrop-blur">
              <PinIcon className="size-3" />
              固定
            </span>
          ) : null}
          {offline?.cached ? (
            <span
              className="rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] tracking-wider text-accent"
              title="已下载到本机，可离线阅读"
            >
              离线
            </span>
          ) : null}
        </div>

        <div
          aria-hidden="true"
          className="absolute inset-x-0 bottom-0 h-1 bg-ink/10"
        >
          <div className="h-full bg-accent/80" style={{ width: `${progress}%` }} />
        </div>
      </div>

      <div className={cn('flex min-w-0 flex-1 flex-col gap-2', isGrid ? 'p-3' : 'pr-1')}>
        <div className="min-w-0">
          <h3
            className="line-clamp-2 font-serif text-[15px] leading-5 text-ink"
            title={book.title}
          >
            {book.title}
          </h3>
          <p className="mt-0.5 truncate text-xs text-muted">{book.author ?? '佚名'}</p>
        </div>
        <div className="flex flex-wrap items-center gap-1">
          <span className="rounded-sm border border-border px-1.5 py-0.5 text-[10px] tracking-wider text-muted">
            {FORMAT_LABELS[book.format]}
          </span>
          {book.reflowAvailable ? (
            <span className="rounded-sm border border-accent/40 px-1.5 py-0.5 text-[10px] tracking-wider text-accent">
              {REFLOW_BADGE_LABEL}
            </span>
          ) : null}
        </div>

        <p className="truncate text-[11px] text-muted">
          {book.uploadedBy.displayName} 上传 · {formatDate(book.createdAt)}
        </p>

        {book.categories.length > 0 ? (
          <ul aria-label="分类" className="flex flex-wrap gap-1">
            {book.categories.map((category) => (
              <li
                key={category.id}
                className="inline-flex items-center gap-1 rounded-full border border-border px-2 py-0.5 text-[10px] text-muted"
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
            {canManage && canRetryConversion(book.conversionStatus) && onRetryConversion ? (
              <Button
                variant="ghost"
                size="sm"
                aria-label={`重试转换《${book.title}》`}
                disabled={retryPending}
                onClick={() => onRetryConversion(book)}
                className="px-2"
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
            className="h-1 min-w-10 flex-1 overflow-hidden rounded-full bg-border/70"
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

        {/* Fore-edge rail: one primary action and quiet management tools. */}
        <div className="flex flex-wrap items-center gap-1 border-t border-border/70 pt-2">
          <Link
            to={`/books/${book.id}/read`}
            aria-label={`阅读《${book.title}》`}
            className={cn(
              'inline-flex min-h-9 w-full basis-full items-center justify-center whitespace-nowrap rounded-md',
              'border border-accent/25 px-3 text-xs font-medium tracking-wide text-accent transition',
              'hover:bg-accent/10 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'sm:w-auto sm:flex-1 sm:basis-auto',
              '[@media(pointer:coarse)]:min-h-11',
            )}
          >
            {progress > 0 ? '继续阅读' : '阅读'}
          </Link>
          {canManage ? (
            <div className="ml-auto flex items-center gap-1 sm:ml-0">
              <Button
                variant="ghost"
                size="icon"
                aria-label={`编辑《${book.title}》`}
                title={`编辑《${book.title}》`}
                onClick={() => onEdit(book)}
              >
                <PencilIcon />
              </Button>
              <Button
                variant="ghost"
                size="icon"
                aria-label={`删除《${book.title}》`}
                title={`删除《${book.title}》`}
                onClick={() => onDelete(book)}
              >
                <TrashIcon />
              </Button>
            </div>
          ) : null}
        </div>
      </div>
    </article>
  );
}
