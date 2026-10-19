import { useEffect, useMemo, useRef, useState } from 'react';
import type { NoteDto, NoteFilters } from '@bookr/shared';
import { Button, EmptyState } from '@bookr/ui';
import { Link } from 'react-router';
import { useBooks } from '../../api/books';
import { downloadNotesExport } from '../../api/notes';
import { messageForApiError } from '../../lib/errorMessages';
import { NoteCard } from './NoteCard';
import { NoteEditDialog } from './NoteEditDialog';
import {
  DEFAULT_NOTES_FILTERS,
  NotesFilterBar,
  toNoteFilters,
} from './NotesFilterBar';
import type { NotesFilterState } from './NotesFilterBar';
import { useDeleteNote, useNoteTags, useNotesList, useOnlineStatus } from './useNotes';

type NotesView = 'list' | 'group';

const CONFLICT_MESSAGE = '这条笔记已在另一台设备更新，已显示最新版本';
const OFFLINE_MESSAGE = '离线时无法浏览笔记库，联网后会自动恢复。';

/** The cross-book notes library: filters, grouped browsing, edit and export. */
export function NotesPage() {
  const [filters, setFilters] = useState<NotesFilterState>(DEFAULT_NOTES_FILTERS);
  const [view, setView] = useState<NotesView>('list');
  const [editing, setEditing] = useState<NoteDto | null>(null);
  const [conflictNotice, setConflictNotice] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const online = useOnlineStatus();

  const noteFilters = useMemo<NoteFilters>(() => toNoteFilters(filters), [filters]);
  const notesQuery = useNotesList(noteFilters);
  const booksQuery = useBooks({ pageSize: 100 });
  const tagsQuery = useNoteTags();
  const deleteNote = useDeleteNote();

  const notes = useMemo(
    () => notesQuery.data?.pages.flatMap((page) => page.items) ?? [],
    [notesQuery.data],
  );

  // Scroll pagination: load the next page when the sentinel nears the viewport.
  // Browsers without IntersectionObserver fall back to the visible button.
  const loadMoreRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const node = loadMoreRef.current;
    if (!node || !notesQuery.hasNextPage || notesQuery.isFetchingNextPage) return;
    if (typeof IntersectionObserver === 'undefined') return;

    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((entry) => entry.isIntersecting)) {
          void notesQuery.fetchNextPage();
        }
      },
      { rootMargin: '400px 0px' },
    );
    observer.observe(node);
    return () => observer.disconnect();
  }, [
    notes.length,
    notesQuery.fetchNextPage,
    notesQuery.hasNextPage,
    notesQuery.isFetchingNextPage,
  ]);

  const groups = useMemo(() => {
    const map = new Map<string, { title: string; notes: NoteDto[] }>();
    for (const note of notes) {
      const existing = map.get(note.book.id);
      if (existing) existing.notes.push(note);
      else map.set(note.book.id, { title: note.book.title, notes: [note] });
    }
    return [...map.entries()];
  }, [notes]);

  function changeFilters(next: NotesFilterState): void {
    setConflictNotice(null);
    setActionError(null);
    setFilters(next);
  }

  function handleSaved(conflict: boolean): void {
    setEditing(null);
    setConflictNotice(conflict ? CONFLICT_MESSAGE : null);
  }

  function handleDelete(note: NoteDto): void {
    setActionError(null);
    deleteNote.mutate(
      { bookId: note.book.id, noteId: note.id },
      { onError: (error) => setActionError(messageForApiError(error)) },
    );
  }

  async function handleExport(): Promise<void> {
    if (!online || exporting) return;
    setActionError(null);
    setExporting(true);
    try {
      // Export always follows the active filters, never the loaded pages.
      const { blob, filename } = await downloadNotesExport(noteFilters);
      const url = URL.createObjectURL(blob);
      const anchor = document.createElement('a');
      anchor.href = url;
      anchor.download = filename;
      document.body.appendChild(anchor);
      anchor.click();
      anchor.remove();
      URL.revokeObjectURL(url);
    } catch (error) {
      setActionError(messageForApiError(error));
    } finally {
      setExporting(false);
    }
  }

  function renderCard(note: NoteDto) {
    return (
      <NoteCard
        key={note.id}
        note={note}
        onEdit={setEditing}
        onDelete={handleDelete}
        deleting={deleteNote.isPending && deleteNote.variables?.noteId === note.id}
      />
    );
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-ink">笔记库</h1>
          <p className="mt-1 text-sm text-muted">你写在所有书里的划线与批注</p>
        </div>
        <div className="flex items-center gap-2">
          {/* Task 7 mounts the AI analysis panel here. */}
          <div className="notes-analysis-slot" />
          <Button
            variant="ghost"
            size="sm"
            disabled={!online || exporting}
            loading={exporting}
            onClick={() => void handleExport()}
          >
            导出 Markdown
          </Button>
        </div>
      </div>

      <NotesFilterBar
        filters={filters}
        books={booksQuery.data?.items ?? []}
        tags={tagsQuery.data ?? []}
        onChange={changeFilters}
      />

      {!online ? (
        <p
          role="status"
          className="rounded-md border border-border bg-surface/70 px-3 py-2 text-sm text-muted"
        >
          {OFFLINE_MESSAGE}
        </p>
      ) : null}

      {conflictNotice ? (
        <p
          role="status"
          className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
        >
          {conflictNotice}
        </p>
      ) : null}

      {actionError ? (
        <p
          role="alert"
          className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
        >
          {actionError}
        </p>
      ) : null}

      <div className="flex flex-wrap items-center justify-between gap-2">
        {notesQuery.data ? (
          <p className="text-xs tracking-widest text-muted">
            共 {notesQuery.data.pages[0]?.total ?? notes.length} 条
            {notes.length < (notesQuery.data.pages[0]?.total ?? notes.length)
              ? ` · 已显示 ${notes.length}`
              : ''}
          </p>
        ) : (
          <span />
        )}
        <div
          role="group"
          aria-label="笔记视图"
          className="flex items-center gap-1 rounded-md border border-border bg-paper/60 p-1"
        >
          {(
            [
              { value: 'list', label: '列表' },
              { value: 'group', label: '按书分组' },
            ] as const
          ).map((option) => (
            <button
              key={option.value}
              type="button"
              aria-pressed={view === option.value}
              onClick={() => setView(option.value)}
              className={
                view === option.value
                  ? 'min-h-9 rounded bg-accent/10 px-3 text-xs tracking-wide text-accent [@media(pointer:coarse)]:min-h-11'
                  : 'min-h-9 rounded px-3 text-xs tracking-wide text-muted transition hover:bg-ink/5 hover:text-ink [@media(pointer:coarse)]:min-h-11'
              }
            >
              {option.label}
            </button>
          ))}
        </div>
      </div>

      {notesQuery.isPending ? (
        <p role="status" className="py-16 text-center text-sm tracking-widest text-muted">
          正在整理笔记…
        </p>
      ) : notesQuery.isError ? (
        <div
          role="alert"
          className="flex flex-col items-center gap-3 rounded-lg border border-highlight/30 bg-highlight/10 px-5 py-10 text-center"
        >
          <p className="text-sm text-highlight">{messageForApiError(notesQuery.error)}</p>
          <Button variant="ghost" size="sm" onClick={() => void notesQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : notes.length === 0 ? (
        <EmptyState
          title="还没有笔记"
          description="在阅读时划线或写下批注，它们会集中到这里。"
          action={
            <Link
              to="/"
              className="text-sm text-accent underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
            >
              去书架挑一本书
            </Link>
          }
        />
      ) : view === 'group' ? (
        <div className="flex flex-col gap-6">
          {groups.map(([bookId, group]) => (
            <section key={bookId} className="flex flex-col gap-3">
              <h2 className="font-serif text-lg text-ink">
                《{group.title}》 · {group.notes.length} 条
              </h2>
              <div className="flex flex-col gap-3">{group.notes.map(renderCard)}</div>
            </section>
          ))}
        </div>
      ) : (
        <div className="flex flex-col gap-3">{notes.map(renderCard)}</div>
      )}

      {!notesQuery.isPending && !notesQuery.isError && notes.length > 0 ? (
        <div className="flex flex-col items-center gap-2 pt-2">
          <div ref={loadMoreRef} aria-hidden="true" className="h-px w-full" />
          {notesQuery.hasNextPage ? (
            <Button
              variant="ghost"
              size="sm"
              loading={notesQuery.isFetchingNextPage}
              onClick={() => void notesQuery.fetchNextPage()}
            >
              加载更多
            </Button>
          ) : (
            <p className="text-[11px] tracking-[0.24em] text-muted">笔记已到底</p>
          )}
        </div>
      ) : null}

      {editing ? (
        <NoteEditDialog
          key={editing.id}
          note={editing}
          onClose={() => setEditing(null)}
          onSaved={handleSaved}
        />
      ) : null}
    </section>
  );
}
