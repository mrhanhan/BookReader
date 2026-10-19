import { useEffect, useState } from 'react';
import type { NoteDto } from '@bookr/shared';
import { Button } from '@bookr/ui';
import { Link } from 'react-router';
import { formatDate } from '../../lib/format';
import { describeNotePosition } from './position';

/** Quotes longer than this are trimmed to keep cards scannable. */
const QUOTE_MAX_LENGTH = 160;
/** Window after the first delete tap in which the second one confirms. */
const CONFIRM_RESET_MS = 3000;

export interface NoteCardProps {
  note: NoteDto;
  onEdit: (note: NoteDto) => void;
  onDelete: (note: NoteDto) => void;
  deleting?: boolean;
}

/** One highlight or note with its book, position, tags and actions. */
export function NoteCard({ note, onEdit, onDelete, deleting = false }: NoteCardProps) {
  const [confirmingDelete, setConfirmingDelete] = useState(false);

  // A tap that is never followed up reverts on its own.
  useEffect(() => {
    if (!confirmingDelete) return;
    const timer = window.setTimeout(() => setConfirmingDelete(false), CONFIRM_RESET_MS);
    return () => window.clearTimeout(timer);
  }, [confirmingDelete]);

  function handleDelete(): void {
    if (!confirmingDelete) {
      setConfirmingDelete(true);
      return;
    }
    setConfirmingDelete(false);
    onDelete(note);
  }

  const quote =
    note.selectedText.length > QUOTE_MAX_LENGTH
      ? `${note.selectedText.slice(0, QUOTE_MAX_LENGTH)}…`
      : note.selectedText;

  return (
    <article
      data-testid="note-card"
      data-note-id={note.id}
      className="flex flex-col gap-3 rounded-lg border border-border bg-surface/80 p-4"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-x-3 gap-y-1">
        <h3 className="min-w-0 truncate font-serif text-base text-ink">{note.book.title}</h3>
        <span className="shrink-0 text-xs tracking-widest text-muted">
          {describeNotePosition(note.locator)}
        </span>
      </div>

      <blockquote className="border-l-2 border-border pl-3 text-sm leading-6 text-ink/90">
        {quote}
      </blockquote>

      {note.noteText ? (
        <p className="text-sm leading-6 text-muted">{note.noteText}</p>
      ) : null}

      {note.tags.length > 0 ? (
        <ul aria-label="标签" className="flex flex-wrap gap-1.5">
          {note.tags.map((tag) => (
            <li
              key={tag}
              className="rounded-full border border-border bg-paper/60 px-2 py-0.5 text-[11px] text-muted"
            >
              {tag}
            </li>
          ))}
        </ul>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        <span className="text-xs text-muted">{formatDate(note.updatedAt)}</span>
        <div className="flex flex-wrap items-center gap-2">
          <Link
            to={`/books/${note.book.id}/read?note=${note.id}`}
            className="whitespace-nowrap rounded-md px-2 py-1 text-xs text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            跳回原文
          </Link>
          <Button variant="ghost" size="sm" onClick={() => onEdit(note)} disabled={deleting}>
            编辑
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={handleDelete}
            disabled={deleting}
            loading={deleting}
          >
            {confirmingDelete ? '确认删除？' : '删除'}
          </Button>
        </div>
      </div>
    </article>
  );
}
