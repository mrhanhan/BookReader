import { useCallback, useEffect, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Link, useParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { readerKindForFormat } from '@bookr/shared';
import type {
  AnnotationColor,
  AnnotationDto,
  BookmarkDto,
  Locator,
  ReaderKind,
} from '@bookr/shared';
import { createReaderEngine, mergeReaderSettings, percentForPage } from '@bookr/reader-core';
import type {
  OpenReaderOptions,
  ReaderDocumentInfo,
  ReaderEngine,
  ReaderHighlight,
  ReaderSelection,
  ReaderSettings,
  TocItem,
} from '@bookr/reader-core';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ApiError } from '../../api/client';
import { useBook } from '../../api/books';
import {
  annotationsQueryKey,
  bookmarksQueryKey,
  createAnnotation,
  deleteAnnotation,
  deleteBookmark,
  fetchAnnotations,
  fetchBookmarks,
  fetchProgress,
  fetchReaderFile,
} from '../../api/reading';
import type { ReaderFileInfo } from '../../api/reading';
import { messageForApiError } from '../../lib/errorMessages';
import { Toast } from '../bookshelf/Toast';
import { loadReaderSettings, saveReaderSettings } from './readerSettings';
import { readLocalProgress, resolveInitialLocator } from './progressStore';
import { isInteractiveTarget } from './interactions';
import { useReaderProgress } from './useReaderProgress';
import { ReaderContent } from './ReaderContent';
import { ReaderChrome } from './ReaderChrome';
import type { ReaderPanelName } from './ReaderChrome';
import { TocPanel } from './TocPanel';
import { SettingsPanel } from './SettingsPanel';
import { SelectionMenu } from './SelectionMenu';
import { AnnotationDialog } from './AnnotationDialog';
import { AnnotationsPanel } from './AnnotationsPanel';
import { BookmarkDialog } from './BookmarkDialog';
import { BookmarksPanel } from './BookmarksPanel';
import './reader.css';

const LOADING_MESSAGE = '正在展开书页…';
const BOOK_MISSING_MESSAGE = '找不到这本书';
const BOOK_TRASHED_MESSAGE = '这本书已不在书架上';
const FILE_MISSING_MESSAGE = '找不到这本书的文件';
const BOOK_NOT_READY_MESSAGE = '这本书正在转换，完成后即可阅读';
const OPEN_FAILED_MESSAGE = '无法打开这本书，请确认文件完整';
/** Chrome hides after this much inactivity while no panel is open. */
const CHROME_HIDE_DELAY_MS = 2_500;

export interface ReaderPageProps {
  /** Tests inject a recording fake; the route uses the real factory. */
  engineFactory?: (kind: ReaderKind) => ReaderEngine;
}

interface ReaderSource {
  file: ReaderFileInfo;
  initialLocator?: Locator;
}

type ReaderStatus = 'loading' | 'ready' | 'error';

/** Maps the reader-file endpoint's failures to reader-facing copy. */
function readerFileFailure(error: unknown): string {
  if (error instanceof ApiError) {
    if (error.code === 'BOOK_NOT_READY') return BOOK_NOT_READY_MESSAGE;
    if (error.code === 'FILE_MISSING' || error.status === 404) return FILE_MISSING_MESSAGE;
  }
  return OPEN_FAILED_MESSAGE;
}

/** Engine navigation is best-effort; a closed engine must not crash the page. */
function ignoreRejection(task: () => Promise<unknown>): void {
  try {
    void Promise.resolve(task()).catch(() => {});
  } catch {
    // The engine refused because it is not open yet.
  }
}

function toggleFullscreen(): void {
  if (typeof document === 'undefined') return;
  try {
    if (document.fullscreenElement) {
      const result = document.exitFullscreen?.();
      if (result) void result.catch(() => {});
    } else {
      const result = document.documentElement.requestFullscreen?.();
      if (result) void result.catch(() => {});
    }
  } catch {
    // Fullscreen is unavailable in this host; reading continues normally.
  }
}

function isEditableTarget(target: EventTarget | null): boolean {
  // Duck-typed rather than `instanceof HTMLElement`: same-origin iframe events
  // come from another realm whose constructors differ from the parent's.
  if (typeof target !== 'object' || target === null) return false;
  const element = target as { tagName?: unknown; isContentEditable?: unknown };
  if (typeof element.tagName !== 'string') return false;
  return (
    element.tagName === 'INPUT' ||
    element.tagName === 'TEXTAREA' ||
    element.tagName === 'SELECT' ||
    element.isContentEditable === true
  );
}

/**
 * Writes text to the clipboard and reports whether it landed. The async
 * Clipboard API is unavailable in some hosts, so a hidden textarea plus
 * `execCommand('copy')` is the fallback.
 */
async function copyText(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    // Permission or feature policy refused; try the legacy path.
  }

  try {
    const area = document.createElement('textarea');
    area.value = text;
    area.setAttribute('readonly', '');
    area.style.position = 'fixed';
    area.style.top = '-1000px';
    area.style.opacity = '0';
    document.body.appendChild(area);
    area.select();
    const copied = document.execCommand ? document.execCommand('copy') : false;
    area.remove();
    return copied;
  } catch {
    return false;
  }
}

/** Projects annotations onto the engine's highlight layer. */
function toHighlights(annotations: AnnotationDto[]): ReaderHighlight[] {
  return annotations.map(({ id, locator, color, noteText }) => ({
    id,
    locator,
    color,
    hasNote: Boolean(noteText),
  }));
}

type AnnotationDialogState =
  | { mode: 'create'; locator: Locator; selectedText: string; color: AnnotationColor }
  | { mode: 'edit'; annotation: AnnotationDto };

type BookmarkDialogState =
  | { mode: 'create'; locator: Locator }
  | { mode: 'edit'; bookmark: BookmarkDto };

function ReaderScreen({ message, busy = false }: { message: string; busy?: boolean }) {
  return (
    <div className="reader-root" data-reader-theme="paper">
      <div className="reader-status" role={busy ? 'status' : 'alert'} aria-live="polite">
        <p>{message}</p>
        {busy ? null : (
          <Link to="/" className="reader-back">
            返回书架
          </Link>
        )}
      </div>
    </div>
  );
}

/**
 * Full-screen reader. It resolves the book, opens the engine against the
 * signed file URL at the newest saved position, and keeps the chrome, panels,
 * keyboard shortcuts and autosave in sync with the engine.
 */
export function ReaderPage({ engineFactory = createReaderEngine }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const bookQuery = useBook(id ?? null);
  const book = bookQuery.data;
  const bookId = book?.id ?? null;
  const kind: ReaderKind | null = book ? readerKindForFormat(book.format) : null;

  const [settings, setSettings] = useState<ReaderSettings>(() => loadReaderSettings());
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // The prop is read through a ref so a new factory identity never rebuilds the
  // engine (and therefore never reopens the book).
  const engineFactoryRef = useRef(engineFactory);
  useEffect(() => {
    engineFactoryRef.current = engineFactory;
  }, [engineFactory]);

  const [engine, setEngine] = useState<ReaderEngine | null>(null);
  useEffect(() => {
    if (!bookId || !kind) return;
    const created = engineFactoryRef.current(kind);
    setEngine(created);
    return () => {
      setEngine(null);
      try {
        void Promise.resolve(created.destroy()).catch(() => {});
      } catch {
        // Tearing down an unopened engine must not throw.
      }
    };
  }, [bookId, kind]);

  const [source, setSource] = useState<ReaderSource | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<ReaderStatus>('loading');
  const [engineFailure, setEngineFailure] = useState<string | null>(null);
  const [documentInfo, setDocumentInfo] = useState<ReaderDocumentInfo | null>(null);
  const [currentLocator, setCurrentLocator] = useState<Locator | null>(null);
  const [panel, setPanel] = useState<ReaderPanelName | null>(null);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [annotationDialog, setAnnotationDialog] = useState<AnnotationDialogState | null>(null);
  const [bookmarkDialog, setBookmarkDialog] = useState<BookmarkDialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const dialogOpen = annotationDialog !== null || bookmarkDialog !== null;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  const queryClient = useQueryClient();
  const annotationsQuery = useQuery({
    queryKey: annotationsQueryKey(bookId ?? ''),
    queryFn: () => fetchAnnotations(bookId ?? ''),
    enabled: bookId !== null && status === 'ready',
  });
  const bookmarksQuery = useQuery({
    queryKey: bookmarksQueryKey(bookId ?? ''),
    queryFn: () => fetchBookmarks(bookId ?? ''),
    enabled: bookId !== null && status === 'ready',
  });
  const annotations = annotationsQuery.data;
  const bookmarks = bookmarksQuery.data;

  const currentLocatorRef = useRef<Locator | null>(null);
  currentLocatorRef.current = currentLocator;

  const showToast = useCallback((message: string) => setToast(message), []);
  const dismissToast = useCallback(() => setToast(null), []);

  // Closing a dialog also drops any selection so a stale menu cannot reappear.
  const closeAnnotationDialog = useCallback(() => {
    setAnnotationDialog(null);
    setSelection(null);
  }, []);
  const closeBookmarkDialog = useCallback(() => {
    setBookmarkDialog(null);
    setSelection(null);
  }, []);

  const contentRef = useRef<HTMLDivElement | null>(null);
  const readyRef = useRef(false);

  // Reset per-book state before any of the loading effects run.
  useEffect(() => {
    setSource(null);
    setLoadFailure(null);
    setStatus('loading');
    setEngineFailure(null);
    setDocumentInfo(null);
    setCurrentLocator(null);
    setPanel(null);
    setSelection(null);
    setAnnotationDialog(null);
    setBookmarkDialog(null);
    setToast(null);
    readyRef.current = false;
  }, [bookId]);

  // Fetch the signed URL and the saved progress in parallel, then compute the
  // one position the reader should open at. Only the file request is fatal: a
  // progress failure must fall back to this device's cache instead of blocking
  // the book.
  useEffect(() => {
    if (!bookId) return;
    let cancelled = false;

    void (async () => {
      try {
        const [file, progress] = await Promise.all([
          fetchReaderFile(bookId),
          fetchProgress(bookId).catch(() => null),
        ]);
        if (cancelled) return;
        setSource({
          file,
          initialLocator: resolveInitialLocator(progress, readLocalProgress(bookId)),
        });
      } catch (error) {
        if (cancelled) return;
        setLoadFailure(readerFileFailure(error));
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bookId]);

  const initialLocator = source?.initialLocator;

  // Autosave must subscribe before `open` so the first relocation is captured.
  const { percent, saveState } = useReaderProgress({
    bookId: bookId ?? '',
    engine,
    initialLocator,
  });

  useEffect(() => {
    if (!engine) return;
    return engine.on('relocated', ({ locator }) => setCurrentLocator(locator));
  }, [engine]);

  useEffect(() => {
    if (initialLocator) {
      setCurrentLocator((previous) => previous ?? initialLocator);
    }
  }, [initialLocator]);

  useEffect(() => {
    const container = contentRef.current;
    if (!engine || !source || !container) return;

    let cancelled = false;
    readyRef.current = false;
    setStatus('loading');
    setEngineFailure(null);

    // Subscribe before opening. Only a load failure is fatal here; a render
    // failure while the book is open must not blank a readable document.
    const unsubscribe = engine.on('error', (payload) => {
      if (cancelled || readyRef.current) return;
      if (payload.code !== 'load-failed') return;
      setStatus('error');
      setEngineFailure(OPEN_FAILED_MESSAGE);
    });

    const options: OpenReaderOptions = {
      initialLocator: source.initialLocator,
      ...(source.file.format === 'pdf'
        ? {
            workerSrc: pdfWorkerUrl,
            cMapUrl: '/cmaps/',
            standardFontDataUrl: '/standard_fonts/',
          }
        : {}),
    };

    void (async () => {
      try {
        const info = await engine.open(
          source.file.url,
          container,
          settingsRef.current,
          options,
        );
        if (cancelled) return;
        readyRef.current = true;
        setEngineFailure(null);
        setDocumentInfo(info);
        setStatus('ready');
      } catch {
        if (cancelled) return;
        setStatus('error');
        setEngineFailure(OPEN_FAILED_MESSAGE);
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [engine, source]);

  const [chromeVisible, setChromeVisible] = useState(true);
  const chromeVisibleRef = useRef(chromeVisible);
  chromeVisibleRef.current = chromeVisible;
  const panelRef = useRef<ReaderPanelName | null>(panel);
  panelRef.current = panel;
  const hideTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const clearHideTimer = useCallback(() => {
    if (hideTimerRef.current !== null) {
      clearTimeout(hideTimerRef.current);
      hideTimerRef.current = null;
    }
  }, []);

  const scheduleHide = useCallback(() => {
    clearHideTimer();
    hideTimerRef.current = setTimeout(() => {
      hideTimerRef.current = null;
      setChromeVisible(false);
    }, CHROME_HIDE_DELAY_MS);
  }, [clearHideTimer]);

  const revealChrome = useCallback(() => {
    setChromeVisible(true);
    if (!panelRef.current) scheduleHide();
  }, [scheduleHide]);

  const hideChrome = useCallback(() => {
    clearHideTimer();
    setChromeVisible(false);
  }, [clearHideTimer]);

  // The inactivity timer is suspended while a panel is open and restarted when
  // it closes (or on mount, before the book is ready).
  useEffect(() => {
    if (panel) {
      clearHideTimer();
      setChromeVisible(true);
    } else {
      scheduleHide();
    }
    return clearHideTimer;
  }, [panel, clearHideTimer, scheduleHide]);

  useEffect(() => {
    if (status === 'ready') revealChrome();
  }, [status, revealChrome]);

  // Real pointer movement reveals the chrome; synthetic/no-op pointer events
  // (fixed coordinates) must not, or a center tap would reveal before it toggles.
  useEffect(() => {
    let lastX = 0;
    let lastY = 0;
    const onPointerMove = (event: PointerEvent): void => {
      if (event.clientX === lastX && event.clientY === lastY) return;
      lastX = event.clientX;
      lastY = event.clientY;
      revealChrome();
    };
    window.addEventListener('pointermove', onPointerMove);
    return () => window.removeEventListener('pointermove', onPointerMove);
  }, [revealChrome]);

  const goPrevious = useCallback(() => {
    if (engine) ignoreRejection(() => engine.previous());
  }, [engine]);

  const goNext = useCallback(() => {
    if (engine) ignoreRejection(() => engine.next());
  }, [engine]);

  const seekPercent = useCallback(
    (value: number) => {
      if (engine) ignoreRejection(() => engine.goToPercent(value));
    },
    [engine],
  );

  const jumpToPage = useCallback(
    (page: number) => {
      if (!engine || kind !== 'pdf') return;
      const count = Math.max(1, documentInfo?.pageCount ?? 1);
      ignoreRejection(() =>
        engine.goTo({ kind: 'pdf', page, percent: percentForPage(page, count) }),
      );
    },
    [engine, kind, documentInfo],
  );

  const togglePanel = useCallback((name: ReaderPanelName) => {
    setPanel((current) => (current === name ? null : name));
  }, []);

  const selectTocItem = useCallback(
    (item: TocItem) => {
      setPanel(null);
      if (engine) ignoreRejection(() => engine.goTo(item.locator, { flash: true }));
    },
    [engine],
  );

  // ---- highlights, notes and bookmarks -----------------------------------

  // The engine owns the visual layer; React only projects the cached items.
  useEffect(() => {
    if (!engine || !annotations) return;
    engine.setHighlights(toHighlights(annotations));
  }, [engine, annotations]);

  useEffect(() => {
    if (!engine) return;
    return engine.on('selection', (payload) => {
      // A dialog owns the screen; selections made under it are ignored so a
      // stale menu cannot pile up behind the modal.
      if (dialogOpenRef.current) return;
      setSelection(payload);
    });
  }, [engine]);

  useEffect(() => {
    if (!engine || !bookId) return;
    return engine.on('highlightClick', ({ id }) => {
      const list =
        queryClient.getQueryData<AnnotationDto[]>(annotationsQueryKey(bookId)) ?? [];
      const found = list.find((annotation) => annotation.id === id);
      if (found) {
        setSelection(null);
        setAnnotationDialog({ mode: 'edit', annotation: found });
      }
    });
  }, [bookId, engine, queryClient]);

  const annotationsError = annotationsQuery.error;
  useEffect(() => {
    if (annotationsError) showToast(messageForApiError(annotationsError));
  }, [annotationsError, showToast]);

  const bookmarksError = bookmarksQuery.error;
  useEffect(() => {
    if (bookmarksError) showToast(messageForApiError(bookmarksError));
  }, [bookmarksError, showToast]);

  /** Applies an annotation change to the cache and mirrors it into the engine. */
  const applyAnnotations = useCallback(
    (updater: (items: AnnotationDto[]) => AnnotationDto[]) => {
      if (!bookId) return;
      const key = annotationsQueryKey(bookId);
      const next = updater(queryClient.getQueryData<AnnotationDto[]>(key) ?? []);
      queryClient.setQueryData(key, next);
      engine?.setHighlights(toHighlights(next));
    },
    [bookId, engine, queryClient],
  );

  const upsertAnnotation = useCallback(
    (annotation: AnnotationDto) => {
      applyAnnotations((items) =>
        items.some((item) => item.id === annotation.id)
          ? items.map((item) => (item.id === annotation.id ? annotation : item))
          : [annotation, ...items],
      );
      if (bookId) void queryClient.invalidateQueries({ queryKey: annotationsQueryKey(bookId) });
    },
    [applyAnnotations, bookId, queryClient],
  );

  const forgetAnnotation = useCallback(
    (annotationId: string) => {
      applyAnnotations((items) => items.filter((item) => item.id !== annotationId));
      if (bookId) void queryClient.invalidateQueries({ queryKey: annotationsQueryKey(bookId) });
    },
    [applyAnnotations, bookId, queryClient],
  );

  const removeAnnotation = useCallback(
    async (annotation: AnnotationDto) => {
      if (!bookId) return;
      // Remove optimistically so the row disappears before the round trip.
      applyAnnotations((items) => items.filter((item) => item.id !== annotation.id));
      try {
        await deleteAnnotation(bookId, annotation.id);
      } catch (error) {
        showToast(messageForApiError(error));
      } finally {
        void queryClient.invalidateQueries({ queryKey: annotationsQueryKey(bookId) });
      }
    },
    [applyAnnotations, bookId, queryClient, showToast],
  );

  const applyBookmarks = useCallback(
    (updater: (items: BookmarkDto[]) => BookmarkDto[]) => {
      if (!bookId) return;
      const key = bookmarksQueryKey(bookId);
      queryClient.setQueryData(key, updater(queryClient.getQueryData<BookmarkDto[]>(key) ?? []));
    },
    [bookId, queryClient],
  );

  const upsertBookmark = useCallback(
    (bookmark: BookmarkDto) => {
      applyBookmarks((items) =>
        items.some((item) => item.id === bookmark.id)
          ? items.map((item) => (item.id === bookmark.id ? bookmark : item))
          : [bookmark, ...items],
      );
      if (bookId) void queryClient.invalidateQueries({ queryKey: bookmarksQueryKey(bookId) });
    },
    [applyBookmarks, bookId, queryClient],
  );

  const removeBookmark = useCallback(
    async (bookmark: BookmarkDto) => {
      if (!bookId) return;
      applyBookmarks((items) => items.filter((item) => item.id !== bookmark.id));
      try {
        await deleteBookmark(bookId, bookmark.id);
      } catch (error) {
        showToast(messageForApiError(error));
      } finally {
        void queryClient.invalidateQueries({ queryKey: bookmarksQueryKey(bookId) });
      }
    },
    [applyBookmarks, bookId, queryClient, showToast],
  );

  const jumpTo = useCallback(
    (locator: Locator) => {
      setPanel(null);
      if (engine) ignoreRejection(() => engine.goTo(locator, { flash: true }));
    },
    [engine],
  );

  const createHighlight = useCallback(
    async (color: AnnotationColor) => {
      if (!selection || !bookId) return;
      const { locator, text } = selection;
      setSelection(null);
      try {
        const created = await createAnnotation(bookId, {
          type: 'highlight',
          color,
          locator,
          selectedText: text,
          tags: [],
        });
        upsertAnnotation(created);
      } catch (error) {
        showToast(messageForApiError(error));
      }
    },
    [bookId, selection, showToast, upsertAnnotation],
  );

  const copySelection = useCallback(async () => {
    const text = selection?.text ?? '';
    setSelection(null);
    const copied = await copyText(text);
    showToast(copied ? '已复制' : '复制失败，请手动选择复制');
  }, [selection, showToast]);

  const openNoteDialog = useCallback(
    (color: AnnotationColor) => {
      if (!selection) return;
      setAnnotationDialog({
        mode: 'create',
        locator: selection.locator,
        selectedText: selection.text,
        color,
      });
      setSelection(null);
    },
    [selection],
  );

  const openBookmarkDialog = useCallback(() => {
    let locator: Locator | null = currentLocatorRef.current;
    if (engine) {
      try {
        locator = engine.currentLocator();
      } catch {
        // Keep the last relocated position when the engine is not ready.
      }
    }
    if (!locator) {
      showToast('还没有可用的阅读位置');
      return;
    }
    setSelection(null);
    setBookmarkDialog({ mode: 'create', locator });
  }, [engine, showToast]);

  // Outside interactions dismiss the selection menu, but never while a dialog
  // is open (the dialog's own controls count as outside taps).
  useEffect(() => {
    if (!selection || dialogOpen) return;

    const onPointerDown = (event: PointerEvent): void => {
      const target = event.target as { closest?: (selector: string) => Element | null } | null;
      if (typeof target?.closest === 'function' && target.closest('.reader-selection-menu')) {
        return;
      }
      setSelection(null);
    };
    const onKeyDown = (event: KeyboardEvent): void => {
      if (event.key === 'Escape') setSelection(null);
    };
    const onScroll = (): void => setSelection(null);

    document.addEventListener('pointerdown', onPointerDown, true);
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('scroll', onScroll, true);
    return () => {
      document.removeEventListener('pointerdown', onPointerDown, true);
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('scroll', onScroll, true);
    };
  }, [selection, dialogOpen]);

  const changeSettings = useCallback((next: ReaderSettings) => {
    const merged = mergeReaderSettings(next);
    setSettings(merged);
    saveReaderSettings(merged);
    engine?.setSettings(merged);
  }, [engine]);

  // Both the parent document and the EPUB iframe call this one implementation.
  const handleTapAt = useCallback(
    (ratio: number): void => {
      if (ratio < 0.25) {
        if (!chromeVisibleRef.current) goPrevious();
        return;
      }
      if (ratio > 0.75) {
        if (!chromeVisibleRef.current) goNext();
        return;
      }
      if (chromeVisibleRef.current) hideChrome();
      else revealChrome();
    },
    [goNext, goPrevious, hideChrome, revealChrome],
  );

  // Keyboard shortcuts. Editable fields and browser-level chords are ignored.
  const handleKeyDown = useCallback(
    (event: KeyboardEvent): void => {
      if (event.metaKey || event.ctrlKey || event.altKey) return;
      if (isEditableTarget(event.target)) return;

      switch (event.key) {
        case 'ArrowLeft':
        case 'PageUp':
          event.preventDefault();
          revealChrome();
          goPrevious();
          break;
        case 'ArrowRight':
        case 'PageDown':
        case ' ':
        case 'Spacebar':
          event.preventDefault();
          revealChrome();
          goNext();
          break;
        case 't':
        case 'T':
          revealChrome();
          togglePanel('toc');
          break;
        case 'b':
        case 'B':
          event.preventDefault();
          // Never swap an in-progress edit or queue a dialog over another one.
          if (status !== 'ready' || dialogOpenRef.current) break;
          revealChrome();
          openBookmarkDialog();
          break;
        case 'f':
        case 'F':
          revealChrome();
          toggleFullscreen();
          break;
        case 'Escape':
          // A modal dialog handles its own Escape; do not also close the panel
          // behind it.
          if (dialogOpenRef.current) break;
          setPanel(null);
          break;
        default:
          break;
      }
    },
    [goNext, goPrevious, openBookmarkDialog, revealChrome, status, togglePanel],
  );

  useEffect(() => {
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [handleKeyDown]);

  /**
   * EPUB renders each section into an iframe, which swallows pointer, click and
   * keyboard events from the parent. Bridge those events back to the same
   * handlers the parent document uses. The observer re-binds after flow/spread
   * re-renders swap the iframe document.
   */
  useEffect(() => {
    const content = contentRef.current;
    if (!content) return;

    interface IframeBridge {
      win: Window | null;
      doc: Document | null;
      detach: () => void;
      onLoad: () => void;
    }

    const bridges = new Map<HTMLIFrameElement, IframeBridge>();

    const bind = (iframe: HTMLIFrameElement, force = false): void => {
      let win: Window | null = null;
      let doc: Document | null = null;
      try {
        win = iframe.contentWindow;
        doc = iframe.contentDocument;
      } catch {
        // Cross-origin content cannot be instrumented; the engine still works.
        return;
      }

      let record = bridges.get(iframe);
      if (!record) {
        record = { win: null, doc: null, detach: () => {}, onLoad: () => bind(iframe, true) };
        bridges.set(iframe, record);
        iframe.addEventListener('load', record.onLoad);
      }
      if (!force && record.win === win && record.doc === doc) return;

      record.detach();
      record.win = win;
      record.doc = doc;
      // A cross-origin frame exposes a window but no document; attaching a
      // listener there would throw a SecurityError.
      if (!win || !doc) {
        record.detach = () => {};
        return;
      }

      let lastX = 0;
      let lastY = 0;
      const onPointerMove = (event: PointerEvent): void => {
        if (event.clientX === lastX && event.clientY === lastY) return;
        lastX = event.clientX;
        lastY = event.clientY;
        revealChrome();
      };
      const onClick = (event: MouseEvent): void => {
        // EPUB links and form controls keep their own behavior.
        if (isInteractiveTarget(event.target)) return;
        try {
          if (win?.getSelection()?.toString()) return;
        } catch {
          // Another realm lost access; treat it as a plain tap.
        }
        // Spreads render two iframes; map the tap against the whole content
        // box so the left/right zones stay monotonic across the screen.
        const contentRect = content.getBoundingClientRect();
        const iframeRect = iframe.getBoundingClientRect();
        let ratio: number;
        if (contentRect.width > 0) {
          ratio =
            (iframeRect.left - contentRect.left + event.clientX) / contentRect.width;
        } else {
          const width = iframe.clientWidth || win?.innerWidth || 0;
          ratio = width > 0 ? event.clientX / width : 0.5;
        }
        handleTapAt(ratio);
      };
      const onKeyDown = (event: KeyboardEvent): void => handleKeyDown(event);

      win.addEventListener('pointermove', onPointerMove);
      win.addEventListener('click', onClick, true);
      win.addEventListener('keydown', onKeyDown, true);
      record.detach = () => {
        win?.removeEventListener('pointermove', onPointerMove);
        win?.removeEventListener('click', onClick, true);
        win?.removeEventListener('keydown', onKeyDown, true);
      };
    };

    const scan = (): void => {
      for (const iframe of content.querySelectorAll('iframe')) bind(iframe);
      for (const [iframe, record] of bridges) {
        if (content.contains(iframe)) continue;
        record.detach();
        try {
          iframe.removeEventListener('load', record.onLoad);
        } catch {
          // A detached iframe is already gone.
        }
        bridges.delete(iframe);
      }
    };

    scan();
    const observer =
      typeof MutationObserver === 'undefined' ? null : new MutationObserver(scan);
    observer?.observe(content, { childList: true, subtree: true });

    return () => {
      observer?.disconnect();
      for (const [iframe, record] of bridges) {
        record.detach();
        iframe.removeEventListener('load', record.onLoad);
      }
      bridges.clear();
    };
  }, [handleKeyDown, handleTapAt, revealChrome]);

  function handleContentTap(event: ReactMouseEvent<HTMLDivElement>): void {
    // A tap that ends a text selection is a selection gesture, not navigation;
    // taps on links and controls belong to those elements as well.
    if (isInteractiveTarget(event.target)) return;
    if (typeof window !== 'undefined' && window.getSelection()?.toString()) return;

    const rect = event.currentTarget.getBoundingClientRect();
    // jsdom has no layout (width 0); treat that as a center tap.
    handleTapAt(rect.width > 0 ? (event.clientX - rect.left) / rect.width : 0.5);
  }

  const page =
    currentLocator?.kind === 'pdf' ? currentLocator.page : 1;
  const fatalMessage = loadFailure ?? engineFailure;

  if (!id || bookQuery.isPending) {
    return <ReaderScreen message={LOADING_MESSAGE} busy />;
  }

  if (bookQuery.isError || !book) {
    return <ReaderScreen message={BOOK_MISSING_MESSAGE} />;
  }

  if (book.deletedAt) {
    return <ReaderScreen message={BOOK_TRASHED_MESSAGE} />;
  }

  return (
    <div
      className="reader-root"
      data-reader-theme={settings.theme}
      data-reader-kind={kind ?? undefined}
    >
      {fatalMessage ? (
        <div className="reader-status" role="alert">
          <p>{fatalMessage}</p>
          <Link to="/" className="reader-back">
            返回书架
          </Link>
        </div>
      ) : (
        <>
          <ReaderContent containerRef={contentRef} onTap={handleContentTap} />

          <div
            className="reader-brightness"
            aria-hidden="true"
            style={{ opacity: Math.max(0, 1 - settings.brightness) }}
          />

          {status === 'loading' ? (
            <div className="reader-status" role="status" aria-live="polite">
              <p>{LOADING_MESSAGE}</p>
            </div>
          ) : null}

          {selection && !dialogOpen ? (
            <SelectionMenu
              selection={selection}
              onHighlight={(color) => void createHighlight(color)}
              onNote={openNoteDialog}
              onCopy={() => void copySelection()}
              onDismiss={() => setSelection(null)}
            />
          ) : null}

          {status === 'ready' && chromeVisible ? (
            <ReaderChrome
              book={book}
              kind={kind ?? 'pdf'}
              documentInfo={documentInfo}
              page={page}
              percent={percent}
              saveState={saveState}
              activePanel={panel}
              onTogglePanel={togglePanel}
              onBookmark={() => togglePanel('bookmarks')}
              onNotes={() => togglePanel('annotations')}
              onFullscreen={toggleFullscreen}
              onPrevious={goPrevious}
              onNext={goNext}
              onSeekPercent={seekPercent}
              onJumpPage={jumpToPage}
              onActivity={revealChrome}
            />
          ) : null}

          {status === 'ready' && panel === 'toc' ? (
            <TocPanel
              toc={documentInfo?.toc ?? []}
              onSelect={selectTocItem}
              onClose={() => setPanel(null)}
            />
          ) : null}

          {status === 'ready' && panel === 'settings' ? (
            <SettingsPanel
              kind={kind ?? 'pdf'}
              settings={settings}
              onChange={changeSettings}
              onClose={() => setPanel(null)}
            />
          ) : null}

          {status === 'ready' && panel === 'annotations' ? (
            <AnnotationsPanel
              annotations={annotations ?? []}
              onJump={(annotation) => jumpTo(annotation.locator)}
              onEdit={(annotation) => setAnnotationDialog({ mode: 'edit', annotation })}
              onDelete={(annotation) => void removeAnnotation(annotation)}
              onClose={() => setPanel(null)}
            />
          ) : null}

          {status === 'ready' && panel === 'bookmarks' ? (
            <BookmarksPanel
              bookmarks={bookmarks ?? []}
              onAdd={openBookmarkDialog}
              onJump={(bookmark) => jumpTo(bookmark.locator)}
              onRename={(bookmark) => setBookmarkDialog({ mode: 'edit', bookmark })}
              onDelete={(bookmark) => void removeBookmark(bookmark)}
              onClose={() => setPanel(null)}
            />
          ) : null}

          {status === 'ready' && annotationDialog ? (
            <AnnotationDialog
              key={annotationDialog.mode === 'edit' ? annotationDialog.annotation.id : 'create'}
              open
              mode={annotationDialog.mode}
              bookId={bookId ?? ''}
              initial={
                annotationDialog.mode === 'edit' ? annotationDialog.annotation : undefined
              }
              draft={
                annotationDialog.mode === 'create'
                  ? {
                      locator: annotationDialog.locator,
                      selectedText: annotationDialog.selectedText,
                      color: annotationDialog.color,
                    }
                  : undefined
              }
              onClose={closeAnnotationDialog}
              onSaved={upsertAnnotation}
              onDeleted={forgetAnnotation}
              onNotice={showToast}
            />
          ) : null}

          {status === 'ready' && bookmarkDialog && bookId ? (
            <BookmarkDialog
              key={bookmarkDialog.mode === 'edit' ? bookmarkDialog.bookmark.id : 'create'}
              open
              bookId={bookId}
              locator={
                bookmarkDialog.mode === 'create'
                  ? bookmarkDialog.locator
                  : bookmarkDialog.bookmark.locator
              }
              initial={
                bookmarkDialog.mode === 'edit' ? bookmarkDialog.bookmark : undefined
              }
              onClose={closeBookmarkDialog}
              onSaved={upsertBookmark}
              onNotice={showToast}
            />
          ) : null}

          {toast ? <Toast message={toast} onDismiss={dismissToast} /> : null}
        </>
      )}
    </div>
  );
}

export default ReaderPage;
