/** CSS class epub.js attaches to every highlight mark. */
export const EPUB_HIGHLIGHT_CLASS = 'bookr-epub-hl';
/** Extra class so the UI can style highlights that carry a note. */
export const EPUB_NOTE_CLASS = 'bookr-epub-hl-note';

export interface NoteHighlightMarker {
  id: string;
  hasNote: boolean;
}

/**
 * Adds or removes the note class on highlight marks.
 *
 * epub.js/marks-pane appends the mark SVG to the parent document's view
 * container (not the iframe document), and `classList.add` rejects
 * space-separated class strings, so the note class has to be decorated
 * separately from the single-token annotation class.
 */
export function decorateNoteMarks(
  root: ParentNode | null | undefined,
  highlights: readonly NoteHighlightMarker[],
): void {
  if (!root) {
    return;
  }

  const noteIds = new Set<string>();
  for (const highlight of highlights) {
    if (highlight.hasNote) {
      noteIds.add(highlight.id);
    }
  }

  try {
    root.querySelectorAll(`.${EPUB_HIGHLIGHT_CLASS}`).forEach((mark) => {
      const id = mark.getAttribute('data-id') ?? '';
      if (noteIds.has(id)) {
        mark.classList.add(EPUB_NOTE_CLASS);
      } else {
        mark.classList.remove(EPUB_NOTE_CLASS);
      }
    });
  } catch {
    // Detached containers and exotic mark implementations are harmless.
  }
}

/**
 * Normalizes epub.js' `Views` collection. `rendition.views()` returns a
 * collection with `all()` (it is not iterable), while tests and future versions
 * may hand over a plain array.
 */
export function viewsOf(collection: unknown): unknown[] {
  if (Array.isArray(collection)) {
    return collection;
  }
  const all = (collection as { all?: unknown } | null)?.all;
  if (typeof all !== 'function') {
    return [];
  }
  try {
    const views = all.call(collection);
    return Array.isArray(views) ? views : [];
  } catch {
    return [];
  }
}

/**
 * Decorates every rendition view. Marks live in `view.element` (the parent
 * document), which is why the iframe documents must not be queried instead.
 */
export function decorateNoteMarksInViews(
  views: readonly unknown[],
  highlights: readonly NoteHighlightMarker[],
): void {
  for (const raw of views) {
    const element = (raw as { element?: Element | null } | null)?.element;
    if (element) {
      decorateNoteMarks(element, highlights);
    }
  }
}
