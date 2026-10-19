import { useEffect, useRef, useState } from 'react';
import type { BookDto, NoteFilters, NoteTagCount } from '@bookr/shared';
import { Input } from '@bookr/ui';

/** Time presets offered next to the note filters. */
export type NotesTimePreset = 'all' | '7d' | '30d' | '1y';

/** Filter state owned by the page before it becomes `NoteFilters`. */
export interface NotesFilterState {
  q: string;
  bookId: string;
  tag: string;
  type: '' | 'highlight' | 'note';
  time: NotesTimePreset;
}

export const DEFAULT_NOTES_FILTERS: NotesFilterState = {
  q: '',
  bookId: '',
  tag: '',
  type: '',
  time: 'all',
};

/** Browser-local calendar date as `YYYY-MM-DD` (no UTC shift). */
function localIsoDate(date: Date): string {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

/**
 * Start of a preset window: `7d` includes today and the six days before it,
 * `30d` the previous 29, and `1y` the previous 364. `all` has no bound.
 */
export function fromForTimePreset(
  preset: NotesTimePreset,
  now: Date = new Date(),
): string | undefined {
  const daysBack = preset === '7d' ? 6 : preset === '30d' ? 29 : preset === '1y' ? 364 : null;
  if (daysBack === null) return undefined;

  const start = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  start.setDate(start.getDate() - daysBack);
  return localIsoDate(start);
}

/** Projects the UI state onto the API filter shape, dropping blank values. */
export function toNoteFilters(
  state: NotesFilterState,
  now: Date = new Date(),
): NoteFilters {
  const search = state.q.trim();
  return {
    q: search === '' ? undefined : search,
    bookId: state.bookId || undefined,
    tag: state.tag || undefined,
    type: state.type || undefined,
    from: fromForTimePreset(state.time, now),
  };
}

export interface NotesFilterBarProps {
  filters: NotesFilterState;
  books: BookDto[];
  tags: NoteTagCount[];
  onChange: (filters: NotesFilterState) => void;
}

const selectClass =
  'min-h-11 w-full rounded-md border border-border bg-surface px-3 text-base text-ink ' +
  'sm:min-h-9 sm:w-auto sm:text-sm ' +
  'focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none';

/** Search, book, tag, type and time filters. Search settles after 300 ms. */
export function NotesFilterBar({ filters, books, tags, onChange }: NotesFilterBarProps) {
  const [search, setSearch] = useState(filters.q);
  // Keep the debounce callback on the newest props without restarting the timer.
  const latest = useRef({ filters, onChange });
  latest.current = { filters, onChange };

  // An external reset must also clear the local search box.
  useEffect(() => {
    setSearch((current) => (current === filters.q ? current : filters.q));
  }, [filters.q]);

  useEffect(() => {
    if (search === latest.current.filters.q) return;

    const timer = window.setTimeout(() => {
      const current = latest.current;
      if (search !== current.filters.q) {
        current.onChange({ ...current.filters, q: search });
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search]);

  return (
    <section
      aria-label="筛选笔记"
      className="grid grid-cols-2 gap-3 rounded-lg border border-border bg-surface/70 p-3.5 sm:flex sm:flex-wrap sm:items-end sm:gap-3 sm:p-4"
    >
      <div className="col-span-2 min-w-0 sm:min-w-52 sm:flex-1">
        <Input
          label="搜索"
          aria-label="搜索笔记"
          type="search"
          value={search}
          placeholder="划线与批注"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="notes-book-filter" className="text-xs font-medium text-muted">
          按书筛选
        </label>
        <select
          id="notes-book-filter"
          className={selectClass}
          value={filters.bookId}
          onChange={(event) => onChange({ ...filters, bookId: event.target.value })}
        >
          <option value="">全部图书</option>
          {books.map((book) => (
            <option key={book.id} value={book.id}>
              {book.title}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="notes-tag-filter" className="text-xs font-medium text-muted">
          按标签筛选
        </label>
        <select
          id="notes-tag-filter"
          className={selectClass}
          value={filters.tag}
          onChange={(event) => onChange({ ...filters, tag: event.target.value })}
        >
          <option value="">全部标签</option>
          {tags.map((tag) => (
            <option key={tag.tag} value={tag.tag}>
              {tag.tag}
            </option>
          ))}
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="notes-type-filter" className="text-xs font-medium text-muted">
          按类型筛选
        </label>
        <select
          id="notes-type-filter"
          className={selectClass}
          value={filters.type}
          onChange={(event) =>
            onChange({ ...filters, type: event.target.value as NotesFilterState['type'] })
          }
        >
          <option value="">全部</option>
          <option value="highlight">划线</option>
          <option value="note">批注</option>
        </select>
      </div>

      <div className="flex min-w-0 flex-col gap-1.5">
        <label htmlFor="notes-time-filter" className="text-xs font-medium text-muted">
          按时间筛选
        </label>
        <select
          id="notes-time-filter"
          className={selectClass}
          value={filters.time}
          onChange={(event) =>
            onChange({ ...filters, time: event.target.value as NotesTimePreset })
          }
        >
          <option value="all">全部时间</option>
          <option value="7d">近 7 天</option>
          <option value="30d">近 30 天</option>
          <option value="1y">近 1 年</option>
        </select>
      </div>
    </section>
  );
}
