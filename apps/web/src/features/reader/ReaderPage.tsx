import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { MouseEvent as ReactMouseEvent } from 'react';
import { Link, useParams, useSearchParams } from 'react-router';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useLiveQuery } from 'dexie-react-hooks';
import { readerKindForFormat } from '@bookr/shared';
import type {
  AnnotationColor,
  AnnotationDto,
  BookmarkDto,
  BookDto,
  Locator,
  ReaderKind,
  SyncEntityType,
} from '@bookr/shared';
import {
  DEFAULT_READER_SETTINGS,
  createReaderEngine,
  locatorForMode,
  mergeReaderSettings,
  percentForPage,
} from '@bookr/reader-core';
import type {
  OpenReaderOptions,
  PdfReadingMode,
  ReaderDocumentInfo,
  ReaderEngine,
  ReaderEngineKind,
  ReaderHighlight,
  ReaderSelection,
  ReaderSettings,
  TocItem,
} from '@bookr/reader-core';
import pdfWorkerUrl from 'pdfjs-dist/build/pdf.worker.min.mjs?url';
import { ApiError } from '../../api/client';
import { useBook } from '../../api/books';
import { useAuth } from '../../app/auth';
import {
  annotationsQueryKey,
  bookmarksQueryKey,
  fetchReaderFile,
} from '../../api/reading';
import { fetchReflowFile } from '../../api/reflow';
import { messageForApiError } from '../../lib/errorMessages';
import {
  OfflineUnavailableError,
  OFFLINE_UNAVAILABLE_MESSAGE,
  resolveBookSource,
} from '../../offline/bookSource';
import { useOfflineSession } from '../../offline/offlineContext';
import { bookFromShelfSnapshot, shelfSnapshotOf } from '../../offline/shelfSnapshot';
import { useSync } from '../../sync/SyncProvider';
import { Toast } from '../bookshelf/Toast';
import {
  clearLegacyReaderSettings,
  readLegacyReaderSettings,
  readerSettingsFromRow,
} from './readerSettings';
import { readLocalProgress } from './progressStore';
import { isInteractiveTarget } from './interactions';
import { useReaderProgress } from './useReaderProgress';
import { useReadingMode } from './useReadingMode';
import { useReaderGestures } from './useReaderGestures';
import type { ReaderSwipeHandlers, ReaderZoomHandlers } from './useReaderGestures';
import { ReaderContent } from './ReaderContent';
import { ReaderChrome } from './ReaderChrome';
import type { ReaderPanelName } from './ReaderChrome';
import { TocPanel } from './TocPanel';
import { SettingsPanel } from './SettingsPanel';
import { SelectionMenu } from './SelectionMenu';
import { AiPanel } from './ai/AiPanel';
import { useAiChat } from './ai/useAiChat';
import type { AiApi, AiContextSource } from './ai/useAiChat';
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
const REFLOW_MISSING_MESSAGE = '无法加载重排包，请切回原版';
const REFLOW_REFRESH_FAILED_MESSAGE = '无法获取重排包，请稍后重试';
const REFLOW_FALLBACK_MESSAGE = '无法加载重排包，已切回原版';
const OFFLINE_REFLOW_MESSAGE = '离线时仅可阅读原版，连接网络后可切换重排';
const NOTE_MISSING_MESSAGE = '没有找到这条笔记，已回到上次位置';
/** Only a well-formed annotation id is worth resolving against the notes list. */
const NOTE_ID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SYNC_CONFLICT_MESSAGES: Record<SyncEntityType, string> = {
  annotation: '此批注已在另一台设备更新，旧版本已保留在历史中',
  bookmark: '此书签已在另一台设备更新，已同步为最新版本',
  reading_progress: '阅读进度已在另一台设备更新，已同步到最新位置',
  reader_settings: '阅读设置已在另一台设备更新，已同步为最新设置',
};
/** Chrome hides after this much inactivity while no panel is open. */
const CHROME_HIDE_DELAY_MS = 2_500;
/**
 * Longest the reader waits for a sync before opening at the locally stored
 * position. Every open runs a fresh sync; offline and failed syncs resolve
 * earlier.
 */
const FIRST_SYNC_WAIT_MS = 1_500;
/**
 * Gesture zoom applies live but writes to the local repository only after the
 * gesture has been quiet this long, so a pinch cannot flood IndexedDB.
 */
const SETTINGS_PERSIST_DELAY_MS = 400;

export interface ReaderPageProps {
  /** Tests inject a recording fake; the route uses the real factory. */
  engineFactory?: (kind: ReaderEngineKind) => ReaderEngine;
  /** Tests inject the AI transport; production uses the default API. */
  aiApi?: Partial<AiApi>;
}

interface ReaderSource {
  /** Signed storage URL when online, cached object URL when reading offline. */
  fileUrl: string;
  /** Pack URL; null when the book has no pack or it is unavailable offline. */
  reflowUrl: string | null;
  /** True when both URLs point at files downloaded to this device. */
  offline: boolean;
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

/**
 * Absence of an offline signal counts as online, which keeps non-browser hosts
 * (tests) on the normal signing path.
 */
function isOnline(): boolean {
  return typeof navigator === 'undefined' || navigator.onLine !== false;
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
export function ReaderPage({ engineFactory = createReaderEngine, aiApi }: ReaderPageProps) {
  const { id } = useParams<{ id: string }>();
  const { user } = useAuth();
  // Local progress is namespaced per account; never read or write it before
  // the signed-in user is known.
  const userId = user?.id ?? null;
  const { repo, requestSync, waitForSync, subscribeConflicts, state: syncState } = useSync();
  const { db, cache } = useOfflineSession();
  const bookQuery = useBook(id ?? null);
  // Cold-start offline: the library API is unreachable, so the metadata
  // snapshot written by the shelf keeps the title and format available.
  const cachedShelfRow = useLiveQuery(
    async () => {
      if (id === undefined || userId === null) return null;
      const row = await db.shelf.get([userId, id]);
      // The compound key already scopes the row; the check keeps a legacy or
      // hand-written row from another account out of this session.
      return row !== undefined && row.userId === userId ? row : null;
    },
    [db, id, userId],
  );
  const book = bookQuery.data ?? (cachedShelfRow ? bookFromShelfSnapshot(cachedShelfRow) : null);
  const bookId = book?.id ?? null;
  const kind: ReaderKind | null = book ? readerKindForFormat(book.format) : null;

  // Settings are per account and live in the local repository. The defaults
  // only cover the moment before the account's document is loaded.
  const [settings, setSettings] = useState<ReaderSettings>(() =>
    mergeReaderSettings(DEFAULT_READER_SETTINGS),
  );
  const settingsRef = useRef(settings);
  settingsRef.current = settings;

  // The open effect runs once per book/account; reading the metadata through a
  // ref lets it snapshot a title that was refreshed after the effect started.
  const bookRef = useRef<BookDto | null>(book);
  bookRef.current = book;

  // A legacy settings entry may only migrate after a sync actually completed.
  // While offline (or after a timed-out first sync) it stays an in-memory
  // preference; this marker retries the write from the next successful sync.
  const [pendingSettingsMigration, setPendingSettingsMigration] = useState<{
    userId: string;
    /** Sync timestamp seen when the open gave up waiting; null means none. */
    syncedAt: number | null;
  } | null>(null);

  // The prop is read through a ref so a new factory identity never rebuilds the
  // engine (and therefore never reopens the book).
  const engineFactoryRef = useRef(engineFactory);
  useEffect(() => {
    engineFactoryRef.current = engineFactory;
  }, [engineFactory]);

  const [engine, setEngine] = useState<ReaderEngine | null>(null);
  // Which book the installed engine was created for. A book change installs a
  // replacement engine in an effect, so one render still holds the previous
  // engine; linked-note jumps must not navigate that stale instance.
  const engineOwnerRef = useRef<{ engine: ReaderEngine; bookId: string } | null>(null);

  const [source, setSource] = useState<ReaderSource | null>(null);
  const [loadFailure, setLoadFailure] = useState<string | null>(null);
  const [status, setStatus] = useState<ReaderStatus>('loading');
  const [engineFailure, setEngineFailure] = useState<string | null>(null);
  const [documentInfo, setDocumentInfo] = useState<ReaderDocumentInfo | null>(null);
  const [currentLocator, setCurrentLocator] = useState<Locator | null>(null);
  const [panel, setPanel] = useState<ReaderPanelName | null>(null);
  const [selection, setSelection] = useState<ReaderSelection | null>(null);
  const [online, setOnline] = useState(() => isOnline());
  const [pendingSelection, setPendingSelection] = useState<{
    text: string;
    locator: Locator;
  } | null>(null);
  const [annotationDialog, setAnnotationDialog] = useState<AnnotationDialogState | null>(null);
  const [bookmarkDialog, setBookmarkDialog] = useState<BookmarkDialogState | null>(null);
  const [toast, setToast] = useState<string | null>(null);

  const dialogOpen = annotationDialog !== null || bookmarkDialog !== null;
  const dialogOpenRef = useRef(dialogOpen);
  dialogOpenRef.current = dialogOpen;

  const queryClient = useQueryClient();
  const annotationsQuery = useQuery({
    queryKey: annotationsQueryKey(bookId ?? ''),
    queryFn: () => repo.listAnnotations(userId ?? '', bookId ?? ''),
    enabled: bookId !== null && userId !== null && status === 'ready',
  });
  const bookmarksQuery = useQuery({
    queryKey: bookmarksQueryKey(bookId ?? ''),
    queryFn: () => repo.listBookmarks(userId ?? '', bookId ?? ''),
    enabled: bookId !== null && userId !== null && status === 'ready',
  });
  const annotations = annotationsQuery.data;
  const bookmarks = bookmarksQuery.data;

  const currentLocatorRef = useRef<Locator | null>(null);
  currentLocatorRef.current = currentLocator;

  // The context source reads the engine and position through refs so the AI
  // controller never depends on the identity of the latest render.
  const engineRef = useRef<ReaderEngine | null>(engine);
  engineRef.current = engine;
  const aiContextRef = useRef<AiContextSource>({
    getTextContext: async (scope) => {
      const active = engineRef.current;
      if (!active) throw new Error('阅读器尚未就绪');
      const result = await active.getTextContext(scope);
      return { text: result.text, label: result.label };
    },
    currentLocator: () => currentLocatorRef.current,
  });

  // The companion lives at page level: closing its panel only hides it, so a
  // summary or explanation keeps streaming while the reader looks at the page.
  const ai = useAiChat({
    bookId: bookId ?? '',
    offline: !online,
    context: aiContextRef.current,
    api: aiApi,
  });

  const showToast = useCallback((message: string) => setToast(message), []);
  const dismissToast = useCallback(() => setToast(null), []);

  // Set immediately before a mode switch; the next open consumes it exactly
  // once, so a later reopen (account switch, remount) uses the stored position.
  const pendingLocatorRef = useRef<Locator | null>(null);
  // The latest resolved source, readable from async handlers without waiting
  // for a render. Signed URLs expire, so refreshes replace entries in place.
  const sourceRef = useRef<ReaderSource | null>(source);
  sourceRef.current = source;
  const bookIdRef = useRef<string | null>(bookId);
  bookIdRef.current = bookId;
  // The book + note pair whose linked-note jump has already been performed.
  const noteJumpedRef = useRef<string | null>(null);
  // Concurrent switch clicks share one signing request per side instead of
  // racing each other; a second click awaits the first result.
  const refreshInFlightRef = useRef<
    Partial<Record<'original' | 'reflow', Promise<boolean>>>
  >({});
  // Bumped only when a whole source is resolved (first load, account switch);
  // refreshing one signed URL must not reopen the same mode.
  const [sourceEpoch, setSourceEpoch] = useState(0);
  // A failed reflow open falls back to the original exactly once per switch.
  const reflowFallbackRef = useRef(false);

  // The settings writer reads the account through a ref: depending on the id
  // directly would change `changeSettings` (and through it the engine-open
  // effect) on every account switch, reopening the book with the old account's
  // settings before the new ones are loaded.
  const userIdRef = useRef<string | null>(userId);
  userIdRef.current = userId;

  const persistTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const persistSettings = useCallback(
    (merged: ReaderSettings) => {
      const currentUserId = userIdRef.current;
      if (!currentUserId) return;

      // The repository row is the source of truth; the outbox entry it writes
      // is what carries the change to other devices. A failed local write must
      // never break reading, and the next change retries with the newer value.
      void repo
        .saveSettings(currentUserId, { ...merged })
        .then(() => requestSync('settings'))
        .catch(() => undefined);
    },
    [repo, requestSync],
  );

  /**
   * Applies settings to the live view immediately. Persistence is separate so
   * a zoom gesture can update on every move and still write only once when it
   * settles (see `persistTimerRef`).
   */
  const applySettings = useCallback(
    (next: ReaderSettings, persist: boolean) => {
      const merged = mergeReaderSettings(next);
      settingsRef.current = merged;
      setSettings(merged);
      engine?.setSettings(merged);

      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
      if (persist) {
        persistSettings(merged);
        return;
      }
      persistTimerRef.current = setTimeout(() => {
        persistTimerRef.current = null;
        // Read the latest value: several transient changes may have landed.
        persistSettings(settingsRef.current);
      }, SETTINGS_PERSIST_DELAY_MS);
    },
    [engine, persistSettings],
  );

  const changeSettings = useCallback(
    (next: ReaderSettings) => applySettings(next, true),
    [applySettings],
  );

  // A pending transient write must not fire after the reader is gone.
  useEffect(
    () => () => {
      if (persistTimerRef.current !== null) {
        clearTimeout(persistTimerRef.current);
        persistTimerRef.current = null;
      }
    },
    [],
  );

  /**
   * Fetches a fresh signed URL for one side of the source. Signed URLs expire
   * after an hour, so every mode switch re-signs before reopening. Repeated
   * calls for the same side share one request. Returns false when the request
   * fails; the caller decides whether that is fatal.
   */
  const refreshSourceFor = useCallback(
    (target: 'original' | 'reflow'): Promise<boolean> => {
      if (!bookId || !sourceRef.current) return Promise.resolve(false);
      const inFlight = refreshInFlightRef.current[target];
      if (inFlight) return inFlight;

      // Cached object URLs never expire and there is no signing endpoint to
      // reach offline; keep the URLs already in the source.
      if (!isOnline()) {
        const current = sourceRef.current;
        if (!current) return Promise.resolve(false);
        return Promise.resolve(target === 'original' || current.reflowUrl !== null);
      }

      const requestBookId = bookId;
      const request = (async (): Promise<boolean> => {
        try {
          if (target === 'reflow') {
            const reflow = await fetchReflowFile(requestBookId);
            if (bookIdRef.current !== requestBookId) return false;
            const latest = sourceRef.current;
            if (!latest) return false;
            const next = { ...latest, reflowUrl: reflow.url };
            sourceRef.current = next;
            setSource(next);
          } else {
            const file = await fetchReaderFile(requestBookId);
            if (bookIdRef.current !== requestBookId) return false;
            const latest = sourceRef.current;
            if (!latest) return false;
            const next = { ...latest, fileUrl: file.url };
            sourceRef.current = next;
            setSource(next);
          }
          return true;
        } catch {
          return false;
        }
      })();

      refreshInFlightRef.current[target] = request;
      void request.finally(() => {
        if (refreshInFlightRef.current[target] === request) {
          delete refreshInFlightRef.current[target];
        }
      });
      return request;
    },
    [bookId],
  );

  /**
   * A reflow document that cannot open must not strand the reader on a fatal
   * page: re-sign the original, map the last position to a PDF page and switch
   * back. Guarded so the same switch cannot loop; if the original also fails,
   * its normal error page is shown.
   */
  const fallbackToOriginal = useCallback(async () => {
    if (reflowFallbackRef.current) return;
    reflowFallbackRef.current = true;
    // A navigation can win the race with the re-signing request; the old
    // book's failure must not toast on or repersist settings for the new one.
    const startedFor = bookIdRef.current;

    const current = pendingLocatorRef.current ?? currentLocatorRef.current;
    pendingLocatorRef.current = current ? locatorForMode(current, 'original') : null;
    await refreshSourceFor('original');
    if (bookIdRef.current !== startedFor) return;

    showToast(REFLOW_FALLBACK_MESSAGE);
    const latest = settingsRef.current;
    changeSettings({
      ...latest,
      pdf: { ...latest.pdf, readingMode: 'original' },
    });
  }, [changeSettings, refreshSourceFor, showToast]);

  /**
   * Switches between the original PDF and its reflow view at the same source
   * position. The URLs fetched when the book opened may already have expired,
   * so the target side is re-signed first. The settings write changes `mode`,
   * which recreates the engine and reopens it; nothing is opened here directly.
   */
  const switchReadingMode = useCallback(
    async (next: PdfReadingMode) => {
      // Re-signing can outlive the current book; a changed id is a silent
      // cancel, not a refresh failure on the next book.
      const startedFor = bookIdRef.current;
      if (next === 'reflow') {
        // Offline there is no signing endpoint; only a downloaded pack can be
        // opened, and the chrome points at the same limitation.
        if (!isOnline() && sourceRef.current?.reflowUrl == null) {
          showToast(OFFLINE_REFLOW_MESSAGE);
          return;
        }
        // The pack URL is required; the PDF URL feeds `sourcePdfUrl` for
        // visual blocks, so re-sign both in parallel. A failed PDF refresh
        // keeps the URL already in the source.
        const [refreshed] = await Promise.all([
          refreshSourceFor('reflow'),
          refreshSourceFor('original'),
        ]);
        if (bookIdRef.current !== startedFor) return;
        if (!refreshed) {
          showToast(isOnline() ? REFLOW_REFRESH_FAILED_MESSAGE : OFFLINE_REFLOW_MESSAGE);
          return;
        }
        reflowFallbackRef.current = false;
      } else {
        // Best-effort: an expired URL is retried, but the old one may still work.
        await refreshSourceFor('original');
        if (bookIdRef.current !== startedFor) return;
      }

      let current = currentLocatorRef.current;
      if (!current && engine) {
        try {
          current = engine.currentLocator();
        } catch {
          // The engine is not open yet; the source position is still usable.
        }
      }
      pendingLocatorRef.current = current ? locatorForMode(current, next) : null;
      const latest = settingsRef.current;
      changeSettings({
        ...latest,
        pdf: { ...latest.pdf, readingMode: next },
      });
    },
    [changeSettings, engine, refreshSourceFor, showToast],
  );

  const reflowReady = source?.reflowUrl != null;
  const sourceReady = source !== null;
  const { mode, reflowAvailable, toggleReflow } = useReadingMode({
    book: book ?? null,
    bookKind: kind,
    reflowReady,
    settings,
    onSwitch: switchReadingMode,
  });

  // The engine kind follows `mode`; the source must be resolved first so a
  // reflow switch always has its signed URL. A refreshed URL alone must not
  // rebuild the engine (the mode change that accompanies it will).
  useEffect(() => {
    if (!bookId || !sourceReady || !mode) return;
    const created = engineFactoryRef.current(mode);
    engineOwnerRef.current = { engine: created, bookId };
    setEngine(created);
    return () => {
      if (engineOwnerRef.current?.engine === created) {
        engineOwnerRef.current = null;
      }
      setEngine(null);
      try {
        void Promise.resolve(created.destroy()).catch(() => {});
      } catch {
        // Tearing down an unopened engine must not throw.
      }
    };
  }, [bookId, sourceReady, mode]);

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
    sourceRef.current = null;
    pendingLocatorRef.current = null;
    reflowFallbackRef.current = false;
    refreshInFlightRef.current = {};
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
    noteJumpedRef.current = null;
  }, [bookId]);

  // Connectivity follows the browser's own events; the source resolver keeps
  // deciding its own fallbacks through `isOnline()`.
  useEffect(() => {
    const update = (): void => setOnline(isOnline());
    window.addEventListener('online', update);
    window.addEventListener('offline', update);
    return () => {
      window.removeEventListener('online', update);
      window.removeEventListener('offline', update);
    };
  }, []);

  // A quote belongs to one book and one account; crossing either drops it.
  useEffect(() => {
    setPendingSelection(null);
  }, [bookId, userId]);

  // Resolve the file URL while this open's sync settles, then read the
  // settings and the position the reader should open at. Waiting for the pull
  // (bounded by FIRST_SYNC_WAIT_MS) keeps a stale local position or an old
  // settings document from hiding what another device wrote, without delaying
  // offline or timed-out opens. The source resolver signs fresh URLs online,
  // falls back to the device copy, and is the only path while offline. A
  // local-store failure must fall back to opening at the start instead of
  // blocking the book. Progress and settings belong to the signed-in account,
  // so nothing is read until that account is known.
  const wantsReflow = book?.reflowAvailable === true;
  useEffect(() => {
    if (!bookId || !userId) return;
    let cancelled = false;

    void (async () => {
      try {
        // The timestamp before this open's sync is the baseline for deciding
        // whether that sync actually completed (or merely timed out).
        const syncedBefore = await repo.getLastSyncedAt(userId).catch(() => null);
        const [resolved] = await Promise.all([
          resolveBookSource({
            cache,
            online: isOnline,
            userId,
            bookId,
            reflowAvailable: wantsReflow,
            fetchFile: (id) => fetchReaderFile(id),
            fetchReflow: (id) => fetchReflowFile(id),
          }),
          waitForSync(FIRST_SYNC_WAIT_MS),
        ]);
        if (cancelled) return;
        const syncedAfter = await repo.getLastSyncedAt(userId).catch(() => null);

        // A successful online open holds authoritative metadata, so keep a
        // shelf snapshot for this book. Without it a cached book whose shelf
        // row was never written (or was pruned) would be listed offline as an
        // unknown book that the reader then cannot open.
        const openedBook = bookRef.current;
        if (!resolved.offline && openedBook !== null && openedBook.id === bookId) {
          void db.shelf
            .put(shelfSnapshotOf(openedBook, userId))
            .catch(() => undefined);
        }

        const storedSettings = await repo.settingsFor(userId).catch(() => null);
        if (cancelled) return;
        // A row without a legacy entry is still authoritative for this account
        // (including "this account never changed anything" → defaults).
        let loadedSettings = readerSettingsFromRow(storedSettings);
        if (storedSettings !== null) {
          // The account row wins; a legacy entry left behind by a failed
          // migration must not leak into another account on this browser.
          clearLegacyReaderSettings();
          setPendingSettingsMigration(null);
        } else {
          // First open after the upgrade: adopt the old global document as the
          // in-memory preference. It is persisted only when the first sync
          // actually completed; otherwise a timed-out open could push a stale
          // local document over a newer one another device just wrote.
          const legacy = readLegacyReaderSettings();
          if (legacy !== null) {
            loadedSettings = legacy;
            const syncCompleted = syncedAfter !== null && syncedAfter !== syncedBefore;
            if (syncCompleted) {
              // Persist in the background so a slow or blocked local store never
              // delays the book. The global entry is dropped only after the
              // account row landed, so a failure retries on the next open.
              void repo
                .saveSettings(userId, { ...legacy })
                .then(() => {
                  clearLegacyReaderSettings();
                  requestSync('settings');
                })
                .catch(() => undefined);
            } else {
              setPendingSettingsMigration({ userId, syncedAt: syncedAfter });
            }
          }
        }
        if (cancelled) return;
        settingsRef.current = loadedSettings;
        setSettings(loadedSettings);

        const progress = await readLocalProgress(repo, userId, bookId).catch(() => null);
        if (cancelled) return;
        setSource({ ...resolved, initialLocator: progress?.locator });
        setSourceEpoch((value) => value + 1);
      } catch (error) {
        if (cancelled) return;
        setLoadFailure(
          error instanceof OfflineUnavailableError
            ? OFFLINE_UNAVAILABLE_MESSAGE
            : readerFileFailure(error),
        );
      }
    })();

    return () => {
      cancelled = true;
    };
  }, [bookId, cache, db, repo, requestSync, userId, waitForSync, wantsReflow]);

  // A deferred legacy migration retries after any sync that completed later
  // than the one observed at open time. The recorded timestamp is the floor:
  // a persisted value from an earlier session must not count as success now.
  const deferredSyncAt = syncState.lastSyncedAt;
  useEffect(() => {
    if (pendingSettingsMigration === null) return;
    const { userId: pendingUser, syncedAt } = pendingSettingsMigration;
    if (deferredSyncAt === null || deferredSyncAt === syncedAt) return;

    let cancelled = false;
    void (async () => {
      const row = await repo.settingsFor(pendingUser).catch(() => null);
      if (cancelled) return;
      if (row !== null) {
        setPendingSettingsMigration(null);
        return;
      }
      const legacy = readLegacyReaderSettings();
      if (legacy === null) {
        setPendingSettingsMigration(null);
        return;
      }

      try {
        await repo.saveSettings(pendingUser, { ...legacy });
        clearLegacyReaderSettings();
        requestSync('settings');
      } catch {
        // Keep the marker so the next successful sync retries.
        return;
      }
      if (!cancelled) setPendingSettingsMigration(null);
    })();

    return () => {
      cancelled = true;
    };
  }, [deferredSyncAt, pendingSettingsMigration, repo, requestSync]);

  const initialLocator = source?.initialLocator;

  // Autosave must subscribe before `open` so the first relocation is captured.
  const { percent, saveState } = useReaderProgress({
    userId: userId ?? '',
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
    // Read the latest signed source: a refresh may have replaced a URL while
    // this mode's engine was being recreated.
    const activeSource = sourceRef.current;
    if (!engine || !activeSource || !mode || !container) return;

    if (mode === 'reflow' && !activeSource.reflowUrl) {
      setStatus('error');
      setEngineFailure(REFLOW_MISSING_MESSAGE);
      return;
    }
    // `mode` changed on this render but the replacement engine has not been
    // installed yet; the next render opens the right URL on the right engine.
    if (engine.kind !== mode) return;

    let cancelled = false;
    readyRef.current = false;
    setStatus('loading');
    setEngineFailure(null);

    const useReflow = mode === 'reflow';

    // A reflow load failure is recoverable: switch the reader back to the
    // original view instead of replacing a readable book with an error page.
    const failLoad = (): void => {
      if (cancelled) return;
      // Ignore a late success: a document that reported a load failure is not
      // opened, and its continuation must not clear the fallback's position.
      cancelled = true;
      if (useReflow) {
        void fallbackToOriginal();
        return;
      }
      setStatus('error');
      setEngineFailure(OPEN_FAILED_MESSAGE);
    };

    // Subscribe before opening. Only a load failure is fatal here; a render
    // failure while the book is open must not blank a readable document.
    const unsubscribe = engine.on('error', (payload) => {
      if (cancelled || readyRef.current) return;
      if (payload.code !== 'load-failed') return;
      failLoad();
    });

    // A mode switch supplies the position mapped for the target view; a plain
    // open uses the stored position. Both are normalized for the mode: a PDF
    // locator passes through to the reflow engine, which maps it with its pack.
    const requested = pendingLocatorRef.current ?? activeSource.initialLocator;
    const initialLocator = requested
      ? locatorForMode(requested, useReflow ? 'reflow' : 'original') ?? requested
      : undefined;
    const options: OpenReaderOptions = {
      initialLocator,
      ...(useReflow ? { sourcePdfUrl: activeSource.fileUrl } : {}),
      ...(kind === 'pdf'
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
          useReflow ? activeSource.reflowUrl! : activeSource.fileUrl,
          container,
          settingsRef.current,
          options,
        );
        if (cancelled) return;
        pendingLocatorRef.current = null;
        readyRef.current = true;
        setEngineFailure(null);
        setDocumentInfo(info);
        setStatus('ready');
      } catch {
        failLoad();
      }
    })();

    return () => {
      cancelled = true;
      unsubscribe();
    };
  }, [engine, kind, mode, sourceEpoch, fallbackToOriginal]);

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

  // ---- zoom and touch gestures -------------------------------------------

  /**
   * Effective scale of the original PDF view. A numeric setting is already
   * the render scale; fit modes take the engine's computed scale, which is the
   * only source that accounts for the viewport and crop.
   */
  const zoomBaseScale = useCallback((): number => {
    const zoom = settingsRef.current.pdf.zoom;
    if (typeof zoom === 'number') return zoom;
    const engineScale = engineRef.current?.currentScale?.();
    return typeof engineScale === 'number' && Number.isFinite(engineScale) && engineScale > 0
      ? engineScale
      : 1;
  }, []);

  const zoomHandlers = useMemo<ReaderZoomHandlers | null>(() => {
    if (mode !== 'pdf') return null;

    const applyZoom = (scale: number, persist: boolean): void => {
      const latest = settingsRef.current;
      applySettings({ ...latest, pdf: { ...latest.pdf, zoom: scale } }, persist);
    };

    return {
      baseScale: zoomBaseScale,
      // Live feedback only; the deferred persist in `applySettings` writes
      // the settled value once the gesture stops.
      onZoom: (scale) => applyZoom(scale, false),
      onZoomEnd: (scale) => applyZoom(scale, false),
    };
  }, [applySettings, mode, zoomBaseScale]);

  const handleDoubleTap = useCallback((): void => {
    if (mode !== 'pdf') return;
    // `mergeReaderSettings` clamps numeric zoom to the supported range.
    const zoom = zoomBaseScale() > 1.5 ? 'fit-width' : 2;
    const latest = settingsRef.current;
    applySettings({ ...latest, pdf: { ...latest.pdf, zoom } }, true);
  }, [applySettings, mode, zoomBaseScale]);

  const swipeEnabled =
    mode === 'epub'
      ? settings.epub.flow === 'paginated'
      : mode === 'pdf'
        ? settings.pdf.mode === 'single' || settings.pdf.mode === 'double'
        : false;

  const swipeHandlers = useMemo<ReaderSwipeHandlers | null>(
    () =>
      mode === null
        ? null
        : {
            enabled: swipeEnabled && panel === null && !dialogOpen,
            onNext: goNext,
            onPrevious: goPrevious,
          },
    [dialogOpen, goNext, goPrevious, mode, panel, swipeEnabled],
  );

  useReaderGestures({
    targetRef: contentRef,
    zoom: zoomHandlers,
    swipe: swipeHandlers,
    onDoubleTap: zoomHandlers ? handleDoubleTap : undefined,
  });

  // EPUB content lives in an iframe whose touches never reach the parent
  // container, so the bridge below reads the current swipe state from a ref.
  const iframeSwipeRef = useRef<ReaderSwipeHandlers | null>(swipeHandlers);
  iframeSwipeRef.current = swipeHandlers;

  /** Chrome/keyboard zoom is an explicit choice and persists immediately. */
  const zoomTo = useCallback(
    (zoom: ReaderSettings['pdf']['zoom']): void => {
      const latest = settingsRef.current;
      applySettings({ ...latest, pdf: { ...latest.pdf, zoom } }, true);
    },
    [applySettings],
  );

  const zoomIn = useCallback(() => zoomTo(zoomBaseScale() * 1.2), [zoomBaseScale, zoomTo]);
  const zoomOut = useCallback(() => zoomTo(zoomBaseScale() / 1.2), [zoomBaseScale, zoomTo]);
  const zoomReset = useCallback(() => zoomTo('fit-width'), [zoomTo]);

  const seekPercent = useCallback(
    (value: number) => {
      if (engine) ignoreRejection(() => engine.goToPercent(value));
    },
    [engine],
  );

  const jumpToPage = useCallback(
    (page: number) => {
      if (!engine || (mode !== 'pdf' && mode !== 'reflow')) return;
      const count = Math.max(1, documentInfo?.pageCount ?? 1);
      const percent = percentForPage(page, count);
      ignoreRejection(() =>
        engine.goTo(
          mode === 'reflow'
            ? { kind: 'reflow', sourcePage: page, percent }
            : { kind: 'pdf', page, percent },
        ),
      );
    },
    [engine, mode, documentInfo],
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

  /**
   * Other surfaces link straight to one note with `?note=<annotationId>`. The
   * annotation already lives in the local repository, so the reader first
   * opens at the last saved position and then relocates once the document is
   * ready and the list has loaded.
   */
  const [searchParams] = useSearchParams();
  const requestedNoteId = searchParams.get('note');
  const noteTargetId =
    requestedNoteId !== null && NOTE_ID_PATTERN.test(requestedNoteId)
      ? requestedNoteId
      : null;
  // Scope the "already handled" marker to the book so a later navigation to a
  // different book (or another note) still jumps. A book change clears it in
  // the per-book reset effect above.
  const noteJumpKey =
    bookId !== null && noteTargetId !== null ? `${bookId}:${noteTargetId}` : null;

  useEffect(() => {
    if (noteJumpKey === null || !engine || status !== 'ready' || !annotations) return;
    // The render that changes `bookId` still holds the previous book's engine
    // until the replacement is installed; never navigate that stale instance.
    const owner = engineOwnerRef.current;
    if (owner === null || owner.engine !== engine || owner.bookId !== bookId) return;
    // A mode switch remaps the position through the open effect; the same id
    // must not pull the reader back to the note's locator again.
    if (noteJumpedRef.current === noteJumpKey) return;

    const target = annotations.find((annotation) => annotation.id === noteTargetId);
    if (target) {
      noteJumpedRef.current = noteJumpKey;
      ignoreRejection(() => engine.goTo(target.locator, { flash: true }));
      return;
    }
    // "Missing" is only known once the list actually loaded. While the query
    // is pending (or disabled) the reader stays quiet and keeps the position.
    if (annotationsQuery.isSuccess) {
      noteJumpedRef.current = noteJumpKey;
      showToast(NOTE_MISSING_MESSAGE);
    }
  }, [
    annotations,
    annotationsQuery.isSuccess,
    bookId,
    engine,
    noteJumpKey,
    noteTargetId,
    showToast,
    status,
  ]);

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

  // Conflicts resolved after the provider mounted map to an entity-specific
  // toast; the provider never replays conflicts counted before mount, so the
  // reader opens quietly even when the session already had some.
  useEffect(
    () =>
      subscribeConflicts((notice) => {
        showToast(SYNC_CONFLICT_MESSAGES[notice.entityType]);
      }),
    [showToast, subscribeConflicts],
  );

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
      if (bookId) {
        void queryClient.invalidateQueries({ queryKey: annotationsQueryKey(bookId) });
        requestSync('annotation');
      }
    },
    [applyAnnotations, bookId, queryClient, requestSync],
  );

  const forgetAnnotation = useCallback(
    (annotationId: string) => {
      applyAnnotations((items) => items.filter((item) => item.id !== annotationId));
      if (bookId) {
        void queryClient.invalidateQueries({ queryKey: annotationsQueryKey(bookId) });
        requestSync('annotation');
      }
    },
    [applyAnnotations, bookId, queryClient, requestSync],
  );

  const removeAnnotation = useCallback(
    async (annotation: AnnotationDto) => {
      if (!bookId || !userId) return;
      // Remove optimistically so the row disappears before the local write.
      applyAnnotations((items) => items.filter((item) => item.id !== annotation.id));
      try {
        await repo.deleteAnnotation(userId, bookId, annotation.id);
      } catch (error) {
        showToast(messageForApiError(error));
      } finally {
        void queryClient.invalidateQueries({ queryKey: annotationsQueryKey(bookId) });
        requestSync('annotation');
      }
    },
    [applyAnnotations, bookId, queryClient, repo, requestSync, showToast, userId],
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
      if (bookId) {
        void queryClient.invalidateQueries({ queryKey: bookmarksQueryKey(bookId) });
        requestSync('bookmark');
      }
    },
    [applyBookmarks, bookId, queryClient, requestSync],
  );

  const removeBookmark = useCallback(
    async (bookmark: BookmarkDto) => {
      if (!bookId || !userId) return;
      applyBookmarks((items) => items.filter((item) => item.id !== bookmark.id));
      try {
        await repo.deleteBookmark(userId, bookId, bookmark.id);
      } catch (error) {
        showToast(messageForApiError(error));
      } finally {
        void queryClient.invalidateQueries({ queryKey: bookmarksQueryKey(bookId) });
        requestSync('bookmark');
      }
    },
    [applyBookmarks, bookId, queryClient, repo, requestSync, showToast, userId],
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
      if (!selection || !bookId || !userId) return;
      const { locator, text } = selection;
      setSelection(null);
      try {
        const created = await repo.createAnnotation(userId, {
          bookId,
          type: 'highlight',
          color,
          locator,
          selectedText: text,
          noteText: null,
          tags: [],
        });
        upsertAnnotation(created);
      } catch (error) {
        showToast(messageForApiError(error));
      }
    },
    [bookId, repo, selection, showToast, upsertAnnotation, userId],
  );

  const copySelection = useCallback(async () => {
    const text = selection?.text ?? '';
    setSelection(null);
    const copied = await copyText(text);
    showToast(copied ? '已复制' : '复制失败，请手动选择复制');
  }, [selection, showToast]);

  const explainSelection = useCallback(() => {
    if (!selection) return;
    const { text, locator } = selection;
    setSelection(null);
    setPanel('ai');
    void ai.explain({ text, locator }).then((sent) => {
      if (!sent && !ai.streaming) showToast('AI 正在准备，请稍候');
    });
  }, [ai, selection, showToast]);

  const summarizePage = useCallback(() => {
    setSelection(null);
    setPanel('ai');
    void ai.summarize('page').then((sent) => {
      if (!sent && !ai.streaming) showToast('AI 正在准备，请稍候');
    });
  }, [ai, showToast]);

  const askAboutSelection = useCallback(() => {
    if (!selection) return;
    const { text, locator } = selection;
    setSelection(null);
    setPanel('ai');
    setPendingSelection({ text, locator });
  }, [selection]);

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

      // Zoom shortcuts only exist for the original PDF view and must not fire
      // through a panel or dialog.
      const canZoom =
        zoomHandlers !== null
        && status === 'ready'
        && panelRef.current === null
        && !dialogOpenRef.current;

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
        case 'i':
        case 'I':
          revealChrome();
          togglePanel('ai');
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
        case '+':
        case '=':
          if (!canZoom) break;
          event.preventDefault();
          zoomIn();
          break;
        case '-':
        case '_':
          if (!canZoom) break;
          event.preventDefault();
          zoomOut();
          break;
        case '0':
          if (!canZoom) break;
          event.preventDefault();
          zoomReset();
          break;
        default:
          break;
      }
    },
    [
      goNext,
      goPrevious,
      openBookmarkDialog,
      revealChrome,
      status,
      togglePanel,
      zoomHandlers,
      zoomIn,
      zoomOut,
      zoomReset,
    ],
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

      // Swipe-to-turn inside the EPUB iframe. The parent gesture hook cannot
      // see these touches because the frame owns its own document.
      let touchStart: { x: number; y: number; at: number } | null = null;
      const onTouchStart = (event: TouchEvent): void => {
        if (event.touches.length !== 1) {
          touchStart = null;
          return;
        }
        const touch = event.touches[0];
        touchStart = touch
          ? { x: touch.clientX, y: touch.clientY, at: Date.now() }
          : null;
      };
      const onTouchEnd = (event: TouchEvent): void => {
        const start = touchStart;
        touchStart = null;
        const swipe = iframeSwipeRef.current;
        if (!start || !swipe?.enabled) return;
        const touch = event.changedTouches[0];
        if (!touch) return;
        const dx = touch.clientX - start.x;
        const dy = touch.clientY - start.y;
        if (Date.now() - start.at > 800) return;
        if (Math.abs(dx) < 60 || Math.abs(dx) <= Math.abs(dy) * 1.5) return;
        try {
          if (win?.getSelection()?.toString()) return;
        } catch {
          // A lost realm cannot report a selection; treat it as a swipe.
        }
        if (dx > 0) swipe.onPrevious();
        else swipe.onNext();
      };

      win.addEventListener('pointermove', onPointerMove);
      win.addEventListener('click', onClick, true);
      win.addEventListener('keydown', onKeyDown, true);
      win.addEventListener('touchstart', onTouchStart, { passive: true });
      win.addEventListener('touchend', onTouchEnd);
      record.detach = () => {
        win?.removeEventListener('pointermove', onPointerMove);
        win?.removeEventListener('click', onClick, true);
        win?.removeEventListener('keydown', onKeyDown, true);
        win?.removeEventListener('touchstart', onTouchStart);
        win?.removeEventListener('touchend', onTouchEnd);
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
    currentLocator?.kind === 'pdf'
      ? currentLocator.page
      : currentLocator?.kind === 'reflow'
        ? currentLocator.sourcePage
        : 1;
  const zoomPercent = mode === 'pdf' ? Math.round(zoomBaseScale() * 100) : null;
  const fatalMessage = loadFailure ?? engineFailure;

  if (!book) {
    // The cached metadata is still loading, or the shelf never saw this book.
    if (bookQuery.isPending || cachedShelfRow === undefined) {
      return <ReaderScreen message={LOADING_MESSAGE} busy />;
    }
    return <ReaderScreen message={BOOK_MISSING_MESSAGE} />;
  }

  if (book.deletedAt) {
    return <ReaderScreen message={BOOK_TRASHED_MESSAGE} />;
  }

  return (
    <div
      className="reader-root"
      data-reader-theme={settings.theme}
      data-reader-kind={mode ?? undefined}
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
              onExplain={explainSelection}
              onSummarizePage={summarizePage}
              onAsk={askAboutSelection}
            />
          ) : null}

          {status === 'ready' && chromeVisible ? (
            <ReaderChrome
              book={book}
              kind={mode ?? 'pdf'}
              reflowAvailable={reflowAvailable}
              reflowReady={reflowReady}
              offline={source?.offline === true}
              onToggleReflow={toggleReflow}
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
              zoomPercent={zoomPercent}
              onZoomIn={zoomIn}
              onZoomOut={zoomOut}
              onZoomReset={zoomReset}
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
              kind={mode ?? 'pdf'}
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

          {status === 'ready' && panel === 'ai' ? (
            <AiPanel
              controller={ai}
              offline={!online}
              onClose={() => setPanel(null)}
              pendingSelection={pendingSelection}
              onClearPending={() => setPendingSelection(null)}
            />
          ) : null}

          {status === 'ready' && annotationDialog ? (
            <AnnotationDialog
              key={annotationDialog.mode === 'edit' ? annotationDialog.annotation.id : 'create'}
              open
              mode={annotationDialog.mode}
              bookId={bookId ?? ''}
              userId={userId ?? ''}
              repo={repo}
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
              userId={userId ?? ''}
              repo={repo}
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
