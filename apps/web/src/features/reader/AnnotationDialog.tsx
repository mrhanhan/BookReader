import { useId, useState } from 'react';
import { HIGHLIGHT_HEX } from '@bookr/reader-core';
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTags } from '@bookr/shared';
import type { AnnotationColor, AnnotationDto, Locator } from '@bookr/shared';
import { Button, Dialog, Input } from '@bookr/ui';
import {
  createAnnotation,
  deleteAnnotation,
  updateAnnotation,
} from '../../api/reading';
import type { UpdateAnnotationInput } from '../../api/reading';
import { messageForApiError } from '../../lib/errorMessages';
import { ANNOTATION_COLOR_OPTIONS } from './colors';

/** Position and text captured by the selection menu for a new note. */
export interface AnnotationDraft {
  locator: Locator;
  selectedText: string;
  color: AnnotationColor;
}

export interface AnnotationDialogProps {
  open: boolean;
  mode: 'create' | 'edit';
  bookId: string;
  initial?: AnnotationDto;
  draft?: AnnotationDraft;
  onClose: () => void;
  onSaved: (annotation: AnnotationDto) => void;
  onDeleted?: (annotationId: string) => void;
  /** Surfaces API failures and revision conflicts as a reader toast. */
  onNotice?: (message: string) => void;
}

const CONFLICT_MESSAGE = '已在其他设备更新，旧版本已保留';
const TAG_LIMIT_MESSAGE = `标签最多 ${MAX_TAGS} 个，每个不超过 ${MAX_TAG_LENGTH} 字`;

const textareaClass =
  'w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none';

/** Splits a comma-separated tag string; `normalizeTags` trims and dedupes. */
function splitTags(raw: string): string[] {
  return raw
    .split(/[,，]/)
    .map((tag) => tag.trim())
    .filter((tag) => tag !== '');
}

/**
 * Creates or edits a note, its highlight color and tags. The parent remounts
 * the dialog for each target, so the initial state is read once on mount.
 */
export function AnnotationDialog({
  open,
  mode,
  bookId,
  initial,
  draft,
  onClose,
  onSaved,
  onDeleted,
  onNotice,
}: AnnotationDialogProps) {
  const noteFieldId = useId();
  const [noteText, setNoteText] = useState(initial?.noteText ?? '');
  const [tagsText, setTagsText] = useState(initial?.tags.join('，') ?? '');
  const [color, setColor] = useState<AnnotationColor>(initial?.color ?? draft?.color ?? 'yellow');
  const [revision, setRevision] = useState(initial?.revision ?? 1);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const trimmed = noteText.trim();
  // Notes always need text. Highlights may save with an empty textarea so the
  // user can clear their note while still editing the color and tags.
  const isEditableHighlight = mode === 'edit' && initial?.type === 'highlight';
  const canSave = !busy && (trimmed.length > 0 || isEditableHighlight);

  function notify(message: string): void {
    setNotice(message);
    onNotice?.(message);
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    setNotice(null);

    const rawTags = splitTags(tagsText);
    // Dedupe before enforcing the cap so repeated entries do not count twice.
    const dedupedTags = Array.from(new Set(rawTags));
    if (
      dedupedTags.length > MAX_TAGS ||
      dedupedTags.some((tag) => tag.length > MAX_TAG_LENGTH)
    ) {
      notify(TAG_LIMIT_MESSAGE);
      return;
    }
    const tags = normalizeTags(rawTags);

    setBusy(true);
    try {
      if (mode === 'edit' && initial) {
        const patch: UpdateAnnotationInput = {
          revision,
          color,
          tags,
        };
        // Highlights may clear their note by emptying the textarea; an existing
        // note always has text here because its Save button requires it.
        patch.noteText =
          initial.type === 'highlight' ? (trimmed.length > 0 ? trimmed : null) : trimmed;
        const result = await updateAnnotation(bookId, initial.id, patch);
        // A stale edit still lands, so the returned annotation is authoritative.
        onSaved(result.annotation);
        setRevision(result.annotation.revision);
        if (result.conflict) {
          notify(CONFLICT_MESSAGE);
          // Adopt the server copy into the open form so the next save is based
          // on the latest revision and text.
          setNoteText(result.annotation.noteText ?? '');
          setTagsText(result.annotation.tags.join('，'));
          setColor(result.annotation.color);
          return;
        }
      } else if (draft) {
        const created = await createAnnotation(bookId, {
          type: 'note',
          color,
          locator: draft.locator,
          selectedText: draft.selectedText,
          noteText: trimmed,
          tags,
        });
        onSaved(created);
      }
      onClose();
    } catch (error) {
      notify(messageForApiError(error));
    } finally {
      setBusy(false);
    }
  }

  async function handleDelete(): Promise<void> {
    if (!initial) return;
    setNotice(null);
    setBusy(true);
    try {
      await deleteAnnotation(bookId, initial.id);
      onDeleted?.(initial.id);
      onClose();
    } catch (error) {
      notify(messageForApiError(error));
      setConfirmingDelete(false);
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  if (confirmingDelete) {
    return (
      <Dialog
        open
        onClose={() => {
          if (!busy) setConfirmingDelete(false);
        }}
        title="删除批注"
        footer={
          <>
            <Button
              variant="ghost"
              onClick={() => setConfirmingDelete(false)}
              disabled={busy}
            >
              取消
            </Button>
            <Button variant="danger" onClick={() => void handleDelete()} loading={busy}>
              确认删除
            </Button>
          </>
        }
      >
        <p className="text-sm leading-6 text-ink">确定删除这条划线或批注吗？删除后无法恢复。</p>
      </Dialog>
    );
  }

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={mode === 'edit' ? '编辑批注' : '新建批注'}
      footer={
        <>
          {mode === 'edit' ? (
            <Button
              variant="danger"
              onClick={() => setConfirmingDelete(true)}
              disabled={busy}
            >
              删除
            </Button>
          ) : null}
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} disabled={!canSave} loading={busy}>
            保存批注
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        {notice ? (
          <p
            role="alert"
            className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
          >
            {notice}
          </p>
        ) : null}

        {initial?.selectedText ?? draft?.selectedText ? (
          <blockquote className="border-l-2 border-border pl-3 text-sm leading-6 text-muted">
            {initial?.selectedText ?? draft?.selectedText}
          </blockquote>
        ) : null}

        <div className="flex flex-col gap-1.5">
          <label htmlFor={noteFieldId} className="text-sm font-medium text-ink">
            批注内容
          </label>
          <textarea
            id={noteFieldId}
            value={noteText}
            onChange={(event) => setNoteText(event.target.value)}
            rows={5}
            placeholder="写下你的想法…"
            className={textareaClass}
          />
        </div>

        <Input
          label="标签（用逗号分隔）"
          value={tagsText}
          onChange={(event) => setTagsText(event.target.value)}
          placeholder="历史，文学"
        />

        <div className="flex flex-col gap-1.5">
          <span className="text-sm font-medium text-ink">划线颜色</span>
          <div className="flex flex-wrap gap-2" role="group" aria-label="划线颜色">
            {ANNOTATION_COLOR_OPTIONS.map((option) => (
              <button
                key={option.color}
                type="button"
                aria-label={`颜色：${option.label}`}
                aria-pressed={color === option.color}
                onClick={() => setColor(option.color)}
                className={`rounded-md border px-3 py-1.5 text-xs text-ink ${
                  color === option.color ? 'border-accent ring-2 ring-accent/30' : 'border-border'
                }`}
                style={{ backgroundColor: HIGHLIGHT_HEX[option.color] }}
              >
                {option.label}
              </button>
            ))}
          </div>
        </div>
      </div>
    </Dialog>
  );
}
