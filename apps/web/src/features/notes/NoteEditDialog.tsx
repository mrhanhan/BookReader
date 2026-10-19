import { useId, useState } from 'react';
import { HIGHLIGHT_HEX } from '@bookr/reader-core';
import { MAX_TAGS, MAX_TAG_LENGTH, normalizeTags } from '@bookr/shared';
import type { AnnotationColor, NoteDto } from '@bookr/shared';
import { Button, Dialog, Input } from '@bookr/ui';
import { messageForApiError } from '../../lib/errorMessages';
import { ANNOTATION_COLOR_OPTIONS } from '../reader/colors';
import { useUpdateNote } from './useNotes';

export interface NoteEditDialogProps {
  note: NoteDto;
  onClose: () => void;
  /** `conflict` means a stale revision overwrote another device's edit. */
  onSaved: (conflict: boolean) => void;
}

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
 * Edits one note's text, tags and color through the annotation REST endpoint.
 * The parent remounts this dialog per target, so initial state is read once.
 */
export function NoteEditDialog({ note, onClose, onSaved }: NoteEditDialogProps) {
  const noteFieldId = useId();
  const [noteText, setNoteText] = useState(note.noteText ?? '');
  const [tagsText, setTagsText] = useState(note.tags.join('，'));
  const [color, setColor] = useState<AnnotationColor>(note.color);
  const [notice, setNotice] = useState<string | null>(null);
  const updateNote = useUpdateNote();

  const trimmed = noteText.trim();
  const canSave = !updateNote.isPending && (note.type === 'highlight' || trimmed.length > 0);

  function handleSave(): void {
    if (!canSave) return;
    setNotice(null);

    const rawTags = splitTags(tagsText);
    // Dedupe before enforcing the cap so repeated entries do not count twice.
    const deduped = Array.from(new Set(rawTags));
    if (deduped.length > MAX_TAGS || deduped.some((tag) => tag.length > MAX_TAG_LENGTH)) {
      setNotice(TAG_LIMIT_MESSAGE);
      return;
    }

    updateNote.mutate(
      {
        bookId: note.book.id,
        noteId: note.id,
        revision: note.revision,
        // Highlights may clear their note; a note always keeps its text.
        noteText: note.type === 'note' ? trimmed : trimmed.length > 0 ? trimmed : null,
        tags: normalizeTags(rawTags),
        color,
      },
      {
        onSuccess: (result) => onSaved(result.conflict),
        onError: (error) => setNotice(messageForApiError(error)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={() => {
        if (!updateNote.isPending) onClose();
      }}
      title="编辑笔记"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={updateNote.isPending}>
            取消
          </Button>
          <Button onClick={handleSave} disabled={!canSave} loading={updateNote.isPending}>
            保存
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

        <blockquote className="border-l-2 border-border pl-3 text-sm leading-6 text-muted">
          {note.selectedText}
        </blockquote>

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
          {note.type === 'note' ? (
            <p className="text-xs text-muted">批注不能为空。</p>
          ) : null}
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
