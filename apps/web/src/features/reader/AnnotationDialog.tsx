import { useId, useState } from 'react';
import { HIGHLIGHT_HEX } from '@bookr/reader-core';
import type { AnnotationColor, AnnotationDto, Locator } from '@bookr/shared';
import { Button, Dialog, Input } from '@bookr/ui';
import {
  createAnnotation,
  deleteAnnotation,
  updateAnnotation,
} from '../../api/reading';
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

const textareaClass =
  'w-full resize-y rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink ' +
  'placeholder:text-muted/60 focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none';

/** Splits a comma-separated tag string, trimming and de-duplicating entries. */
export function parseTags(raw: string): string[] {
  const tags: string[] = [];
  const seen = new Set<string>();
  for (const part of raw.split(/[,，]/)) {
    const tag = part.trim();
    if (tag === '' || seen.has(tag)) continue;
    seen.add(tag);
    tags.push(tag);
  }
  return tags;
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
  const [busy, setBusy] = useState(false);
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  const trimmed = noteText.trim();
  const canSave = trimmed.length > 0 && !busy;

  function notify(message: string): void {
    onNotice?.(message);
  }

  async function handleSave(): Promise<void> {
    if (!canSave) return;
    setBusy(true);
    try {
      if (mode === 'edit' && initial) {
        const result = await updateAnnotation(bookId, initial.id, {
          revision: initial.revision,
          noteText: trimmed,
          color,
          tags: parseTags(tagsText),
        });
        if (result.conflict) notify(CONFLICT_MESSAGE);
        // A stale edit still lands, so the returned annotation is authoritative.
        onSaved(result.annotation);
      } else if (draft) {
        const created = await createAnnotation(bookId, {
          type: 'note',
          color,
          locator: draft.locator,
          selectedText: draft.selectedText,
          noteText: trimmed,
          tags: parseTags(tagsText),
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
