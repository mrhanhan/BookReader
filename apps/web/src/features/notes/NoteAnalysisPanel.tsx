import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { JSX } from 'react';
import type {
  NoteAnalysisDto,
  NoteAnalysisKind,
  NoteAnalysisSummaryDto,
  NoteFilters,
} from '@bookr/shared';
import { Button } from '@bookr/ui';
import { messageForApiError } from '../../lib/errorMessages';
import { formatDateTime } from '../../lib/format';
import { noteAnalysisApi, useNoteAnalysis } from './useNoteAnalysis';
import type { NoteAnalysisApi } from './useNoteAnalysis';

export interface NoteAnalysisPanelProps {
  filters: NoteFilters;
  online: boolean;
  /** Tests inject a fake transport; production uses the real REST/SSE API. */
  api?: NoteAnalysisApi;
  onClose(): void;
}

const KIND_LABELS: Record<NoteAnalysisKind, string> = {
  themes: '主题归纳',
  viewpoints: '观点梳理',
  todos: '待办提取',
};

const KINDS: readonly NoteAnalysisKind[] = ['themes', 'viewpoints', 'todos'];

const OFFLINE_HINT = '离线时无法使用 AI 分析';
const IDLE_HINT = '选择一种分析方式，然后开始分析。';
const INTERRUPTED_HINT = '已停止，已生成的部分已保存';

const FOCUSABLE_SELECTOR = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(', ');

/**
 * The notes page's AI analysis drawer: a right-side panel on desktop and a
 * bottom sheet on phones. It streams one analysis at a time and keeps the
 * reader's recent saved analyses below the generated text.
 */
export function NoteAnalysisPanel({
  filters,
  online,
  api = noteAnalysisApi,
  onClose,
}: NoteAnalysisPanelProps): JSX.Element {
  const [history, setHistory] = useState<NoteAnalysisSummaryDto[]>([]);
  const [historyLoading, setHistoryLoading] = useState(true);
  const [historyError, setHistoryError] = useState<string | null>(null);
  const [openError, setOpenError] = useState<string | null>(null);
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [saved, setSaved] = useState<NoteAnalysisDto | null>(null);
  const [savedLoading, setSavedLoading] = useState(false);
  const mounted = useRef(true);
  const historyRetry = useRef<number | null>(null);
  const panelRef = useRef<HTMLElement | null>(null);
  const headingRef = useRef<HTMLHeadingElement | null>(null);
  // Opening B while A is in flight must discard A's late response.
  const savedToken = useRef(0);

  useEffect(() => {
    mounted.current = true;
    headingRef.current?.focus();
    return () => {
      mounted.current = false;
      if (historyRetry.current !== null) {
        window.clearTimeout(historyRetry.current);
        historyRetry.current = null;
      }
    };
  }, []);

  const refreshHistory = useCallback(async () => {
    try {
      const items = await api.list();
      if (!mounted.current) return;
      setHistory(items);
      setHistoryError(null);
    } catch (error) {
      if (!mounted.current) return;
      setHistoryError(messageForApiError(error));
    } finally {
      if (mounted.current) setHistoryLoading(false);
    }
  }, [api]);

  // Every settled run has a server row, including stopped and failed ones, so
  // the transport wrapper refreshes the history even when the fake stream
  // resolves in the same tick as it started.
  const trackedApi = useMemo<NoteAnalysisApi>(
    () => ({
      list: api.list,
      get: api.get,
      remove: api.remove,
      async stream(body, handlers, options) {
        try {
          await api.stream(body, handlers, options);
        } finally {
          // Do not delay the interrupted/complete state on the list request.
          void refreshHistory();
          // The server persists an aborted analysis after the socket closes;
          // one quiet retry picks up the interrupted row that the first list
          // request usually races.
          historyRetry.current = window.setTimeout(() => {
            historyRetry.current = null;
            if (mounted.current) void refreshHistory();
          }, 900);
        }
      },
    }),
    [api, refreshHistory],
  );

  const analysis = useNoteAnalysis(trackedApi, filters);

  useEffect(() => {
    void refreshHistory();
  }, [refreshHistory]);

  useEffect(() => {
    function handleKey(event: KeyboardEvent): void {
      if (event.key === 'Escape') {
        onClose();
        return;
      }
      if (event.key !== 'Tab') return;

      const panel = panelRef.current;
      if (!panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR),
      );
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      if (!first || !last) {
        // Nothing interactive is left (for example while everything is busy).
        event.preventDefault();
        return;
      }

      const active = document.activeElement;
      const inside = active instanceof Node && panel.contains(active);
      if (!inside) {
        event.preventDefault();
        (event.shiftKey ? last : first).focus();
        return;
      }
      if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      } else if (
        event.shiftKey &&
        (active === first || active === headingRef.current)
      ) {
        event.preventDefault();
        last.focus();
      }
    }
    window.addEventListener('keydown', handleKey);
    return () => window.removeEventListener('keydown', handleKey);
  }, [onClose]);

  function startAnalysis(): void {
    if (!online) return;
    // A saved-detail request still in flight must not overwrite the new stream.
    savedToken.current += 1;
    setSaved(null);
    setSavedLoading(false);
    setOpenError(null);
    setPendingDelete(null);
    analysis.run();
  }

  async function openSaved(id: string): Promise<void> {
    const token = savedToken.current + 1;
    savedToken.current = token;
    setPendingDelete(null);
    setOpenError(null);
    // Clear the previous detail immediately so a slow response cannot leave
    // another analysis's text looking like the one just clicked.
    setSaved(null);
    setSavedLoading(true);

    try {
      const detail = await api.get(id);
      if (!mounted.current || savedToken.current !== token) return;
      setSaved(detail);
      setOpenError(null);
    } catch (error) {
      if (!mounted.current || savedToken.current !== token) return;
      setOpenError(messageForApiError(error));
    } finally {
      if (mounted.current && savedToken.current === token) setSavedLoading(false);
    }
  }

  async function remove(id: string): Promise<void> {
    if (pendingDelete !== id) {
      setPendingDelete(id);
      return;
    }
    setPendingDelete(null);
    try {
      await api.remove(id);
      if (!mounted.current) return;
      // Discard a detail response that was already loading the deleted row.
      savedToken.current += 1;
      setSavedLoading(false);
      if (saved?.id === id) setSaved(null);
      await refreshHistory();
    } catch (error) {
      if (!mounted.current) return;
      setHistoryError(messageForApiError(error));
    }
  }

  const displayStatus = saved ? saved.status : analysis.status;
  const displayContent = savedLoading ? '' : saved ? saved.content : analysis.content;
  const displayError = saved ? null : analysis.error;

  return (
    <>
      <div
        aria-hidden="true"
        onClick={onClose}
        className="fixed inset-0 z-30 bg-ink/25"
      />
      <aside
        ref={panelRef}
        role="complementary"
        aria-label="AI 笔记分析"
        className={[
          'fixed inset-y-0 right-0 z-40 flex w-[min(26rem,100vw)] flex-col',
          'border-l border-border bg-surface text-ink shadow-2xl',
          'max-sm:inset-x-0 max-sm:top-auto max-sm:bottom-0 max-sm:h-[88dvh]',
          'max-sm:w-full max-sm:max-w-none max-sm:rounded-t-xl max-sm:border-t',
          'max-sm:border-l-0',
        ].join(' ')}
      >
        <header className="flex items-center justify-between gap-3 border-b border-border px-4 py-3">
          <h2
            ref={headingRef}
            tabIndex={-1}
            className="font-serif text-lg text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent"
          >
            AI 笔记分析
          </h2>
          <Button variant="ghost" size="sm" onClick={onClose}>
            关闭
          </Button>
        </header>

        <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto px-4 py-4">
          <div role="group" aria-label="分析类型" className="flex flex-wrap gap-2">
            {KINDS.map((option) => (
              <Button
                key={option}
                size="sm"
                variant={analysis.kind === option ? 'primary' : 'ghost'}
                aria-pressed={analysis.kind === option}
                disabled={analysis.running}
                onClick={() => analysis.setKind(option)}
              >
                {KIND_LABELS[option]}
              </Button>
            ))}
          </div>

          <div className="flex flex-wrap items-center gap-2">
            {analysis.running ? (
              <Button size="sm" variant="ghost" onClick={() => analysis.stop()}>
                停止
              </Button>
            ) : (
              <Button size="sm" disabled={!online} onClick={startAnalysis}>
                开始分析
              </Button>
            )}
            {!online ? (
              <span role="status" className="text-xs text-muted">
                {OFFLINE_HINT}
              </span>
            ) : null}
          </div>

          {analysis.running ? (
            <p role="status" className="text-xs tracking-wide text-muted">
              正在分析 {analysis.noteCount ?? '…'} 条笔记（实际纳入{' '}
              {analysis.analyzedCount ?? '…'} 条）…
            </p>
          ) : null}

          {saved ? (
            <p className="text-xs text-muted">
              共 {saved.noteCount} 条笔记（实际纳入 {saved.analyzedCount} 条）
            </p>
          ) : null}

          <section aria-label="分析内容" className="flex flex-col gap-2">
            {openError ? (
              <p
                role="alert"
                className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
              >
                {openError}
              </p>
            ) : null}
            {savedLoading ? (
              <p role="status" className="text-sm text-muted">
                正在加载分析…
              </p>
            ) : null}
            {!savedLoading && displayContent === '' && displayStatus === 'idle' ? (
              <p className="text-sm text-muted">{IDLE_HINT}</p>
            ) : null}
            <div
              data-status={displayStatus}
              className="whitespace-pre-wrap text-sm leading-6 text-ink"
            >
              {displayContent}
            </div>
            {displayStatus === 'interrupted' ? (
              <p role="status" className="text-xs text-muted">
                {INTERRUPTED_HINT}
              </p>
            ) : null}
            {displayStatus === 'failed' && displayError ? (
              <p
                role="alert"
                className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
              >
                {displayError}
              </p>
            ) : null}
          </section>

          <section
            aria-label="最近分析"
            className="flex flex-col gap-2 border-t border-border pt-3"
          >
            <h3 className="text-xs font-medium tracking-widest text-muted">最近分析</h3>
            {historyLoading ? (
              <p role="status" className="text-xs text-muted">
                正在加载…
              </p>
            ) : historyError ? (
              <div className="flex flex-col items-start gap-2">
                <p role="alert" className="text-xs text-highlight">
                  {historyError}
                </p>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setHistoryLoading(true);
                    void refreshHistory();
                  }}
                >
                  重试
                </Button>
              </div>
            ) : history.length === 0 ? (
              <p className="text-xs text-muted">还没有分析记录</p>
            ) : (
              <ul className="flex flex-col gap-2">
                {history.map((item) => (
                  <li
                    key={item.id}
                    className="rounded-md border border-border bg-paper/60 px-3 py-1"
                  >
                    <button
                      type="button"
                      disabled={analysis.running}
                      onClick={() => void openSaved(item.id)}
                      className="block w-full truncate py-2 text-left text-sm text-ink underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent disabled:cursor-not-allowed disabled:opacity-60 [@media(pointer:coarse)]:min-h-11"
                    >
                      {item.title}
                    </button>
                    <div className="flex items-center justify-between gap-2 pb-1">
                      <span className="text-[11px] text-muted">
                        {formatDateTime(item.createdAt)}
                      </span>
                      <div className="flex items-center gap-1">
                        {pendingDelete === item.id ? (
                          <Button
                            size="sm"
                            variant="ghost"
                            disabled={analysis.running}
                            onClick={() => setPendingDelete(null)}
                          >
                            取消
                          </Button>
                        ) : null}
                        <Button
                          size="sm"
                          variant="ghost"
                          disabled={analysis.running}
                          onClick={() => void remove(item.id)}
                        >
                          {pendingDelete === item.id ? '确认删除' : '删除'}
                        </Button>
                      </div>
                    </div>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
      </aside>
    </>
  );
}
