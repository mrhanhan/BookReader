import type { CategoryDto } from '@bookr/shared';
import { Button, Dialog, EmptyState, Input, cn } from '@bookr/ui';
import { useCallback, useState } from 'react';
import {
  useCategories,
  useCreateCategory,
  useDeleteCategory,
  useReorderCategories,
  useUpdateCategory,
} from '../../api/categories';
import type { UpdateCategoryInput } from '../../api/categories';
import { messageForApiError } from '../../lib/errorMessages';
import { Toast } from '../bookshelf/Toast';
import { AdminTabs } from './AdminTabs';

/** A short, shared sentence for a failed administration request. */
const alertClass =
  'rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight';

/** The server caps a category name at 30 characters. */
const NAME_MAX_LENGTH = 30;

interface CategoryRowProps {
  category: CategoryDto;
  /** Position in the displayed list, which is the order the server returns. */
  index: number;
  total: number;
  busy: boolean;
  onMove: (category: CategoryDto, offset: number) => void;
  onSave: (category: CategoryDto, patch: UpdateCategoryInput) => void;
  onDelete: (category: CategoryDto) => void;
}

/**
 * One category line. The name and colour are edited in place, and the row
 * stacks its controls on a 360px screen instead of scrolling sideways.
 */
function CategoryRow({
  category,
  index,
  total,
  busy,
  onMove,
  onSave,
  onDelete,
}: CategoryRowProps) {
  const [editing, setEditing] = useState(false);
  const [name, setName] = useState(category.name);
  const [color, setColor] = useState(category.color);
  const [error, setError] = useState<string | null>(null);

  function startEditing() {
    setName(category.name);
    setColor(category.color);
    setError(null);
    setEditing(true);
  }

  function save() {
    const trimmed = name.trim();
    if (trimmed.length === 0) {
      setError('分类名称不能为空');
      return;
    }
    if (trimmed.length > NAME_MAX_LENGTH) {
      setError(`分类名称最多 ${NAME_MAX_LENGTH} 个字`);
      return;
    }

    const patch: UpdateCategoryInput = {};
    if (trimmed !== category.name) patch.name = trimmed;
    if (color !== category.color) patch.color = color;
    if (Object.keys(patch).length === 0) {
      setEditing(false);
      return;
    }

    setError(null);
    onSave(category, patch);
    setEditing(false);
  }

  if (editing) {
    return (
      <li className="flex flex-col gap-3 px-4 py-3">
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Input
              label={`重命名 ${category.name}`}
              value={name}
              maxLength={NAME_MAX_LENGTH}
              disabled={busy}
              error={error ?? undefined}
              onChange={(event) => {
                setName(event.target.value);
                setError(null);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label
              htmlFor={`category-color-${category.id}`}
              className="text-sm font-medium text-ink"
            >
              颜色
            </label>
            <input
              id={`category-color-${category.id}`}
              type="color"
              aria-label={`${category.name} 的颜色`}
              value={color}
              disabled={busy}
              onChange={(event) => setColor(event.target.value)}
              className="h-9 w-14 rounded-md border border-border bg-surface p-1"
            />
          </div>
        </div>
        <div className="flex flex-wrap gap-1.5">
          <Button size="sm" loading={busy} onClick={save}>
            保存
          </Button>
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => setEditing(false)}>
            取消
          </Button>
        </div>
      </li>
    );
  }

  return (
    <li className="flex flex-col gap-2 px-4 py-3 sm:flex-row sm:items-center sm:gap-3">
      <div className="flex min-w-0 items-center gap-3">
        <span
          aria-hidden="true"
          className="size-4 shrink-0 rounded-full border border-border"
          style={{ backgroundColor: category.color }}
        />
        <span className="min-w-0 truncate text-sm text-ink">{category.name}</span>
        <span className="shrink-0 font-mono text-xs text-muted">{category.color}</span>
      </div>

      <div className="flex flex-wrap gap-1 sm:ml-auto sm:flex-nowrap">
        <Button
          variant="ghost"
          size="sm"
          aria-label={`上移 ${category.name}`}
          disabled={busy || index === 0}
          onClick={() => onMove(category, -1)}
        >
          上移
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`下移 ${category.name}`}
          disabled={busy || index === total - 1}
          onClick={() => onMove(category, 1)}
        >
          下移
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`编辑 ${category.name}`}
          disabled={busy}
          onClick={startEditing}
        >
          编辑
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`删除 ${category.name}`}
          disabled={busy}
          onClick={() => onDelete(category)}
        >
          删除
        </Button>
      </div>
    </li>
  );
}

interface DeleteCategoryDialogProps {
  category: CategoryDto;
  onClose: () => void;
  onDeleted: (category: CategoryDto) => void;
}

/** Deleting a category only detaches it, so the dialog says so out loud. */
function DeleteCategoryDialog({ category, onClose, onDeleted }: DeleteCategoryDialogProps) {
  const deleteCategory = useDeleteCategory();
  const [error, setError] = useState<string | null>(null);

  function confirm() {
    setError(null);
    deleteCategory.mutate(category.id, {
      onSuccess: () => {
        onDeleted(category);
        onClose();
      },
      onError: (cause) => setError(messageForApiError(cause)),
    });
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="删除分类"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={deleteCategory.isPending}>
            取消
          </Button>
          <Button variant="danger" onClick={confirm} loading={deleteCategory.isPending}>
            确认删除
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm leading-6 text-highlight">
          删除「{category.name}」只会解除书籍与它的关联，不会删除任何图书。
        </p>
        {error ? (
          <p role="alert" className={alertClass}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Administration for the shelf's shared categories. */
export function CategoriesPage() {
  const categoriesQuery = useCategories();
  const createCategory = useCreateCategory();
  const updateCategory = useUpdateCategory();
  const reorderCategories = useReorderCategories();

  const [newName, setNewName] = useState('');
  const [newColor, setNewColor] = useState('#8C5A3B');
  const [createError, setCreateError] = useState<string | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<CategoryDto | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissToast = useCallback(() => setNotice(null), []);

  const categories = categoriesQuery.data ?? [];
  const savingId = updateCategory.isPending ? updateCategory.variables?.id : undefined;
  const reordering = reorderCategories.isPending;

  function create() {
    const name = newName.trim();
    if (name.length === 0) {
      setCreateError('分类名称不能为空');
      return;
    }
    setCreateError(null);
    createCategory.mutate(
      { name, color: newColor },
      {
        onSuccess: (category) => {
          setNewName('');
          setNotice(`已创建 ${category.name}`);
        },
        onError: (cause) => setCreateError(messageForApiError(cause)),
      },
    );
  }

  function save(category: CategoryDto, patch: UpdateCategoryInput) {
    setPageError(null);
    updateCategory.mutate(
      { id: category.id, patch },
      {
        onSuccess: () => setNotice(`已更新 ${patch.name ?? category.name}`),
        onError: (cause) => setPageError(messageForApiError(cause)),
      },
    );
  }

  /** Swaps the category with its neighbour and sends the whole order. */
  function move(category: CategoryDto, offset: number) {
    const from = categories.findIndex((item) => item.id === category.id);
    const to = from + offset;
    if (from < 0 || to < 0 || to >= categories.length) return;

    const next = [...categories];
    const moved = next[from]!;
    next[from] = next[to]!;
    next[to] = moved;

    setPageError(null);
    reorderCategories.mutate(
      next.map((item) => item.id),
      {
        onSuccess: () => setNotice(`已调整 ${category.name} 的顺序`),
        onError: (cause) => {
          setPageError(messageForApiError(cause));
          // The server only accepts the full list, so a failure usually means
          // another tab added or removed a category. Resync the list rather
          // than making the administrator reload the page to try again.
          void categoriesQuery.refetch();
        },
      },
    );
  }

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="font-serif text-2xl text-ink">分类</h1>
        <p className="mt-1 text-sm text-muted">整理书架上共享的分类：改名、换色、排序与删除。</p>
      </div>

      <AdminTabs />

      {pageError ? (
        <p role="alert" className={alertClass}>
          {pageError}
        </p>
      ) : null}

      <section aria-labelledby="categories-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="categories-heading" className="font-serif text-lg text-ink">
            分类列表
          </h2>
          {categoriesQuery.data ? (
            <p className="text-xs tracking-widest text-muted">{categories.length} 个</p>
          ) : null}
        </div>

        {categoriesQuery.isPending ? (
          <p role="status" className="py-10 text-center text-sm tracking-widest text-muted">
            正在整理分类…
          </p>
        ) : categoriesQuery.isError ? (
          <div role="alert" className={cn(alertClass, 'flex flex-wrap items-center gap-3')}>
            <span>{messageForApiError(categoriesQuery.error)}</span>
            <Button variant="ghost" size="sm" onClick={() => categoriesQuery.refetch()}>
              重试
            </Button>
          </div>
        ) : categories.length === 0 ? (
          <EmptyState title="还没有分类" description="在下面建一个，再把书架上的书归进去。" />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface/70">
            {categories.map((category, index) => (
              <CategoryRow
                key={category.id}
                category={category}
                index={index}
                total={categories.length}
                busy={savingId === category.id || reordering}
                onMove={move}
                onSave={save}
                onDelete={setDeleting}
              />
            ))}
          </ul>
        )}
      </section>

      <section
        aria-labelledby="new-category-heading"
        className="flex flex-col gap-3 rounded-lg border border-dashed border-border px-4 py-4"
      >
        <h2 id="new-category-heading" className="font-serif text-lg text-ink">
          新建分类
        </h2>
        <div className="flex flex-col gap-3 sm:flex-row sm:items-end">
          <div className="min-w-0 flex-1">
            <Input
              label="分类名称"
              value={newName}
              maxLength={NAME_MAX_LENGTH}
              placeholder="例如：历史"
              disabled={createCategory.isPending}
              error={createError ?? undefined}
              onChange={(event) => {
                setNewName(event.target.value);
                setCreateError(null);
              }}
            />
          </div>
          <div className="flex flex-col gap-1.5">
            <label htmlFor="new-category-color" className="text-sm font-medium text-ink">
              颜色
            </label>
            <input
              id="new-category-color"
              type="color"
              aria-label="新分类的颜色"
              value={newColor}
              disabled={createCategory.isPending}
              onChange={(event) => setNewColor(event.target.value)}
              className="h-9 w-14 rounded-md border border-border bg-surface p-1"
            />
          </div>
          <Button loading={createCategory.isPending} onClick={create}>
            创建分类
          </Button>
        </div>
      </section>

      {deleting ? (
        <DeleteCategoryDialog
          key={deleting.id}
          category={deleting}
          onClose={() => setDeleting(null)}
          onDeleted={(category) => setNotice(`已删除 ${category.name}`)}
        />
      ) : null}

      {notice ? <Toast message={notice} onDismiss={dismissToast} /> : null}
    </section>
  );
}
