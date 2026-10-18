import { useId, useState } from 'react';
import type { ChangeEvent } from 'react';
import type { BookDto, BookStatus, UpdateBookInput } from '@bookr/shared';
import { Button, Dialog, Input, cn } from '@bookr/ui';
import { useCategories, useCreateCategory } from '../../api/categories';
import { useRetryConversion, useUpdateBook, useUploadCover } from '../../api/books';
import { messageForApiError } from '../../lib/errorMessages';
import { CONVERSION_LABELS, STATUS_LABELS, canRetryConversion } from './labels';

export interface EditBookDialogProps {
  book: BookDto;
  onClose: () => void;
}

const COVER_MAX_BYTES = 5 * 1024 * 1024;
const COVER_TYPES = ['image/png', 'image/jpeg', 'image/webp'];
const COVER_EXTENSION = /\.(png|jpe?g|webp)$/i;

const textareaClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none';
const selectClass =
  'w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink ' +
  'focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none';

function isCoverImage(file: File): boolean {
  return COVER_TYPES.includes(file.type) || (file.type === '' && COVER_EXTENSION.test(file.name));
}

/** Metadata and cover editing for a book the current user manages. */
export function EditBookDialog({ book, onClose }: EditBookDialogProps) {
  const categoriesQuery = useCategories();
  const createCategory = useCreateCategory();
  const updateBook = useUpdateBook();
  const uploadCover = useUploadCover();
  const retryConversion = useRetryConversion();
  const statusId = useId();
  const descriptionId = useId();
  const coverId = useId();
  const coverHintId = useId();

  const [title, setTitle] = useState(book.title);
  const [author, setAuthor] = useState(book.author ?? '');
  const [description, setDescription] = useState(book.description ?? '');
  const [status, setStatus] = useState<BookStatus>(book.status);
  const [categoryIds, setCategoryIds] = useState<string[]>(
    book.categories.map((category) => category.id),
  );
  const [formError, setFormError] = useState<string | null>(null);
  const [coverError, setCoverError] = useState<string | null>(null);
  const [coverPreview, setCoverPreview] = useState(book.coverUrl);
  const [newCategoryName, setNewCategoryName] = useState('');
  const [newCategoryColor, setNewCategoryColor] = useState('#8C5A3B');
  const [categoryError, setCategoryError] = useState<string | null>(null);
  const [conversionStatus, setConversionStatus] = useState(book.conversionStatus);
  const [conversionError, setConversionError] = useState(book.conversionError);
  const [retryNotice, setRetryNotice] = useState<string | null>(null);

  const categories = categoriesQuery.data ?? [];

  function toggleCategory(categoryId: string) {
    setCategoryIds((current) =>
      current.includes(categoryId)
        ? current.filter((id) => id !== categoryId)
        : [...current, categoryId],
    );
  }

  function handleCreateCategory() {
    const name = newCategoryName.trim();
    if (!name) {
      setCategoryError('分类名称不能为空');
      return;
    }
    setCategoryError(null);
    createCategory.mutate(
      { name, color: newCategoryColor },
      {
        onSuccess: (category) => {
          setNewCategoryName('');
          // Select the new category right away; the list refetches behind it.
          setCategoryIds((current) =>
            current.includes(category.id) ? current : [...current, category.id],
          );
        },
        onError: (error) => setCategoryError(messageForApiError(error)),
      },
    );
  }

  function handleRetryConversion() {
    setConversionError(null);
    setRetryNotice(null);
    retryConversion.mutate(book.id, {
      onSuccess: () => {
        setConversionStatus('pending');
        setRetryNotice('已重新提交转换，完成后会自动刷新。');
      },
      onError: (error) => setConversionError(messageForApiError(error)),
    });
  }

  function handleCoverChange(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    setCoverError(null);

    if (!isCoverImage(file)) {
      setCoverError('封面仅支持 PNG、JPEG 或 WebP');
      event.target.value = '';
      return;
    }
    if (file.size > COVER_MAX_BYTES) {
      setCoverError('封面不能超过 5 MB');
      event.target.value = '';
      return;
    }

    uploadCover.mutate(
      { id: book.id, file },
      {
        onSuccess: (coverUrl) => setCoverPreview(coverUrl),
        onError: (error) => setCoverError(messageForApiError(error)),
      },
    );
    event.target.value = '';
  }

  function handleSave() {
    setFormError(null);
    const trimmedTitle = title.trim();
    if (!trimmedTitle) {
      setFormError('书名不能为空');
      return;
    }

    const patch: UpdateBookInput = {
      title: trimmedTitle,
      author: author.trim() || null,
      description: description.trim() || null,
      status,
      categoryIds,
    };

    updateBook.mutate(
      { id: book.id, patch },
      {
        onSuccess: onClose,
        onError: (error) => setFormError(messageForApiError(error)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title={`编辑《${book.title}》`}
      className="w-[min(36rem,calc(100vw-2rem))]"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={updateBook.isPending}>
            取消
          </Button>
          <Button onClick={handleSave} loading={updateBook.isPending}>
            保存
          </Button>
        </>
      }
    >
      <div className="flex max-h-[64vh] flex-col gap-4 overflow-y-auto pr-1">
        {formError ? (
          <p
            role="alert"
            className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
          >
            {formError}
          </p>
        ) : null}

        {conversionStatus !== 'none' ? (
          <div className="flex flex-col gap-1.5 rounded-md border border-border px-3 py-2">
            <div className="flex flex-wrap items-center justify-between gap-2">
              <span className="text-sm text-ink">
                EPUB 转换：{CONVERSION_LABELS[conversionStatus]}
              </span>
              {canRetryConversion(conversionStatus) ? (
                <Button
                  variant="ghost"
                  size="sm"
                  loading={retryConversion.isPending}
                  onClick={handleRetryConversion}
                >
                  重试转换
                </Button>
              ) : null}
            </div>
            {conversionStatus === 'failed' && conversionError ? (
              <p role="alert" className="text-xs text-highlight">
                {conversionError}
              </p>
            ) : null}
            {retryNotice ? (
              <p role="status" className="text-xs text-accent">
                {retryNotice}
              </p>
            ) : null}
          </div>
        ) : null}

        <Input
          label="书名"
          value={title}
          onChange={(event) => setTitle(event.target.value)}
          maxLength={200}
        />
        <Input
          label="作者"
          value={author}
          onChange={(event) => setAuthor(event.target.value)}
          maxLength={100}
          placeholder="不填则显示佚名"
        />

        <div className="flex flex-col gap-1.5">
          <label htmlFor={descriptionId} className="text-sm font-medium text-ink">
            简介
          </label>
          <textarea
            id={descriptionId}
            rows={4}
            value={description}
            maxLength={2000}
            onChange={(event) => setDescription(event.target.value)}
            className={textareaClass}
          />
        </div>

        <div className="flex flex-col gap-1.5">
          <label htmlFor={statusId} className="text-sm font-medium text-ink">
            状态
          </label>
          <select
            id={statusId}
            value={status}
            onChange={(event) => setStatus(event.target.value as BookStatus)}
            className={selectClass}
          >
            {(Object.keys(STATUS_LABELS) as BookStatus[]).map((value) => (
              <option key={value} value={value}>
                {STATUS_LABELS[value]}
              </option>
            ))}
          </select>
        </div>

        <fieldset className="flex flex-col gap-2">
          <legend className="text-sm font-medium text-ink">分类</legend>
          {categoriesQuery.isPending ? (
            <p className="text-xs text-muted">正在加载分类…</p>
          ) : categories.length === 0 ? (
            <p className="text-xs text-muted">还没有分类，可以在下面新建一个。</p>
          ) : (
            <div className="flex flex-wrap gap-x-5 gap-y-2">
              {categories.map((category) => (
                <label
                  key={category.id}
                  className="flex items-center gap-2 text-sm text-ink"
                  htmlFor={`${statusId}-category-${category.id}`}
                >
                  <input
                    id={`${statusId}-category-${category.id}`}
                    type="checkbox"
                    checked={categoryIds.includes(category.id)}
                    onChange={() => toggleCategory(category.id)}
                    className="size-4 rounded border-border accent-accent"
                  />
                  <span
                    aria-hidden="true"
                    className="size-2 rounded-full"
                    style={{ backgroundColor: category.color }}
                  />
                  {category.name}
                </label>
              ))}
            </div>
          )}

          <div className="flex flex-wrap items-end gap-2 rounded-md border border-dashed border-border px-3 py-2">
            <div className="min-w-40 flex-1">
              <Input
                label="新建分类"
                value={newCategoryName}
                maxLength={40}
                placeholder="例如：历史"
                error={categoryError ?? undefined}
                onChange={(event) => setNewCategoryName(event.target.value)}
              />
            </div>
            <div className="flex flex-col gap-1.5">
              <label htmlFor={`${statusId}-category-color`} className="text-sm font-medium text-ink">
                颜色
              </label>
              <input
                id={`${statusId}-category-color`}
                type="color"
                aria-label="分类颜色"
                value={newCategoryColor}
                onChange={(event) => setNewCategoryColor(event.target.value)}
                className="h-9 w-14 rounded-md border border-border bg-surface p-1"
              />
            </div>
            <Button
              variant="ghost"
              size="sm"
              loading={createCategory.isPending}
              onClick={handleCreateCategory}
            >
              创建分类
            </Button>
          </div>
        </fieldset>

        <div className="flex flex-col gap-2 border-t border-border pt-4">
          <label htmlFor={coverId} className="text-sm font-medium text-ink">
            更换封面
          </label>
          <div className="flex items-center gap-3">
            <div className="flex h-16 w-12 shrink-0 items-center justify-center overflow-hidden rounded border border-border bg-paper">
              {coverPreview ? (
                <img
                  src={coverPreview}
                  alt={`《${book.title}》封面`}
                  className="h-full w-full object-cover"
                />
              ) : (
                <span aria-hidden="true" className="font-serif text-lg text-accent/50">
                  {book.title.slice(0, 1)}
                </span>
              )}
            </div>
            <div className="flex min-w-0 flex-col gap-1">
              <input
                id={coverId}
                type="file"
                accept="image/png,image/jpeg,image/webp"
                aria-describedby={coverHintId}
                disabled={uploadCover.isPending}
                onChange={handleCoverChange}
                className={cn(
                  'text-xs text-muted file:mr-3 file:rounded-md file:border file:border-border',
                  'file:bg-surface file:px-3 file:py-1.5 file:text-xs file:text-ink',
                  'hover:file:bg-ink/5 disabled:opacity-60',
                )}
              />
              <p id={coverHintId} className="text-xs text-muted">
                PNG、JPEG 或 WebP，不超过 5 MB
              </p>
            </div>
          </div>
          {uploadCover.isPending ? (
            <p className="text-xs text-muted" role="status">
              正在上传封面…
            </p>
          ) : coverError ? (
            <p role="alert" className="text-xs text-highlight">
              {coverError}
            </p>
          ) : uploadCover.isSuccess ? (
            <p className="text-xs text-accent">封面已更新</p>
          ) : null}
        </div>
      </div>
    </Dialog>
  );
}
