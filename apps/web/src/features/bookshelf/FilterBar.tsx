import { useEffect, useRef, useState } from 'react';
import type { BookFormat, BookStatus, CategoryDto } from '@bookr/shared';
import { cn, Input } from '@bookr/ui';
import type { BookSort } from '../../api/books';
import { FORMAT_LABELS, SORT_LABELS, STATUS_LABELS } from './labels';

export interface ShelfFilters {
  query: string;
  format: BookFormat | '';
  status: BookStatus | '';
  categoryId: string;
  sort: BookSort;
  page: number;
  pageSize: number;
}

export const DEFAULT_FILTERS: ShelfFilters = {
  query: '',
  format: '',
  status: '',
  categoryId: '',
  sort: 'recent',
  page: 1,
  pageSize: 24,
};

export type ShelfView = 'grid' | 'list';

export interface FilterBarProps {
  filters: ShelfFilters;
  categories: CategoryDto[];
  view: ShelfView;
  onChange: (filters: ShelfFilters) => void;
  onViewChange: (view: ShelfView) => void;
}

const selectClass =
  'rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink ' +
  'focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none';

/** Search, filters and the grid/list switch. Search settles after 300 ms. */
export function FilterBar({ filters, categories, view, onChange, onViewChange }: FilterBarProps) {
  const [search, setSearch] = useState(filters.query);
  // Keep the debounce callback on the newest props without restarting the timer.
  const latest = useRef({ filters, onChange });
  latest.current = { filters, onChange };

  // A reset (or an external clear) must also clear the local search box.
  useEffect(() => {
    setSearch((current) => (current === filters.query ? current : filters.query));
  }, [filters.query]);

  useEffect(() => {
    if (search === latest.current.filters.query) return;

    const timer = window.setTimeout(() => {
      const current = latest.current;
      if (search !== current.filters.query) {
        current.onChange({ ...current.filters, query: search, page: 1 });
      }
    }, 300);

    return () => window.clearTimeout(timer);
  }, [search]);

  return (
    <section
      aria-label="筛选书架"
      className="flex flex-wrap items-end gap-3 rounded-lg border border-border bg-surface/70 p-4"
    >
      <div className="min-w-52 flex-1">
        <Input
          label="搜索"
          type="search"
          value={search}
          placeholder="书名或作者"
          onChange={(event) => setSearch(event.target.value)}
        />
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="shelf-format-filter" className="text-xs font-medium text-muted">
          格式
        </label>
        <select
          id="shelf-format-filter"
          className={selectClass}
          value={filters.format}
          onChange={(event) =>
            onChange({ ...filters, format: event.target.value as BookFormat | '', page: 1 })
          }
        >
          <option value="">全部格式</option>
          {(Object.keys(FORMAT_LABELS) as BookFormat[]).map((format) => (
            <option key={format} value={format}>
              {FORMAT_LABELS[format]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="shelf-status-filter" className="text-xs font-medium text-muted">
          状态
        </label>
        <select
          id="shelf-status-filter"
          className={selectClass}
          value={filters.status}
          onChange={(event) =>
            onChange({ ...filters, status: event.target.value as BookStatus | '', page: 1 })
          }
        >
          <option value="">全部状态</option>
          {(Object.keys(STATUS_LABELS) as BookStatus[]).map((status) => (
            <option key={status} value={status}>
              {STATUS_LABELS[status]}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="shelf-category-filter" className="text-xs font-medium text-muted">
          分类
        </label>
        <select
          id="shelf-category-filter"
          className={selectClass}
          value={filters.categoryId}
          onChange={(event) => onChange({ ...filters, categoryId: event.target.value, page: 1 })}
        >
          <option value="">全部分类</option>
          {categories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </div>

      <div className="flex flex-col gap-1.5">
        <label htmlFor="shelf-sort-filter" className="text-xs font-medium text-muted">
          排序
        </label>
        <select
          id="shelf-sort-filter"
          className={selectClass}
          value={filters.sort}
          onChange={(event) =>
            onChange({ ...filters, sort: event.target.value as BookSort, page: 1 })
          }
        >
          {(Object.keys(SORT_LABELS) as BookSort[]).map((sort) => (
            <option key={sort} value={sort}>
              {SORT_LABELS[sort]}
            </option>
          ))}
        </select>
      </div>

      <div
        role="group"
        aria-label="视图切换"
        className="ml-auto flex items-center gap-1 rounded-md border border-border bg-paper/60 p-1"
      >
        {(
          [
            { value: 'grid', label: '网格视图' },
            { value: 'list', label: '列表视图' },
          ] as const
        ).map((option) => (
          <button
            key={option.value}
            type="button"
            aria-label={option.label}
            aria-pressed={view === option.value}
            onClick={() => onViewChange(option.value)}
            className={cn(
              'rounded px-2.5 py-1 text-xs tracking-wide transition',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              view === option.value
                ? 'bg-accent/10 text-accent'
                : 'text-muted hover:bg-ink/5 hover:text-ink',
            )}
          >
            {option.value === 'grid' ? '网格' : '列表'}
          </button>
        ))}
      </div>
    </section>
  );
}
