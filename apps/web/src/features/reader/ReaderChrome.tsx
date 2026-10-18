import { useEffect, useState } from 'react';
import type { BookDto } from '@bookr/shared';
import type { ReaderDocumentInfo, ReaderEngineKind } from '@bookr/reader-core';
import { Link } from 'react-router';
import { SyncStatusBadge } from '../settings/SyncStatusBadge';
import { SAVE_STATE_LABELS } from './useReaderProgress';
import type { ReaderSaveState } from './useReaderProgress';

export type ReaderPanelName = 'toc' | 'settings' | 'annotations' | 'bookmarks';

export interface ReaderChromeProps {
  book: BookDto;
  kind: ReaderEngineKind;
  /** The book has a stored pack. */
  reflowAvailable: boolean;
  /** The signed pack URL resolved; false after a failed fetch until a retry. */
  reflowReady: boolean;
  onToggleReflow: () => void;
  documentInfo: ReaderDocumentInfo | null;
  /** Current 1-based source page; ignored for EPUB. */
  page: number;
  /** 0–1 book position. */
  percent: number;
  saveState: ReaderSaveState;
  activePanel: ReaderPanelName | null;
  onTogglePanel: (panel: ReaderPanelName) => void;
  onBookmark: () => void;
  onNotes: () => void;
  onFullscreen: () => void;
  onPrevious: () => void;
  onNext: () => void;
  onSeekPercent: (percent: number) => void;
  onJumpPage: (page: number) => void;
  /** Pointer/keyboard use on the chrome counts as reader activity. */
  onActivity: () => void;
}

/**
 * The floating reader controls: a paper top bar and a bottom navigation bar.
 * It is conditionally rendered by the page, so hiding it also removes it from
 * the accessibility tree.
 */
export function ReaderChrome({
  book,
  kind,
  reflowAvailable,
  reflowReady,
  onToggleReflow,
  documentInfo,
  page,
  percent,
  saveState,
  activePanel,
  onTogglePanel,
  onBookmark,
  onNotes,
  onFullscreen,
  onPrevious,
  onNext,
  onSeekPercent,
  onJumpPage,
  onActivity,
}: ReaderChromeProps) {
  const pageCount = Math.max(1, documentInfo?.pageCount ?? 1);
  const safePage = Math.min(Math.max(1, Math.round(page)), pageCount);
  const percentValue = Math.round(Math.min(1, Math.max(0, percent)) * 100);
  const [pageText, setPageText] = useState(String(safePage));

  useEffect(() => {
    setPageText(String(safePage));
  }, [safePage]);

  function jumpToTypedPage(): void {
    const parsed = Number.parseInt(pageText, 10);
    if (!Number.isFinite(parsed)) {
      setPageText(String(safePage));
      return;
    }
    const target = Math.min(Math.max(parsed, 1), pageCount);
    setPageText(String(target));
    onJumpPage(target);
  }

  return (
    <>
      <header
        className="reader-chrome reader-chrome-top"
        onPointerDown={onActivity}
        onKeyDown={onActivity}
      >
        <Link to="/" className="reader-back">
          返回书架
        </Link>

        <div className="reader-title-block">
          <h1 className="reader-title">{book.title}</h1>
          <p className="reader-author">{book.author ?? '佚名'}</p>
        </div>

        <nav className="reader-actions" aria-label="阅读工具">
          {kind === 'pdf' || kind === 'reflow' ? (
            <button
              type="button"
              aria-pressed={kind === 'reflow'}
              disabled={!reflowAvailable}
              title={
                !reflowAvailable
                  ? '尚未上传重排包'
                  : !reflowReady
                    ? '重排包地址获取失败，点击重试'
                    : undefined
              }
              onClick={onToggleReflow}
            >
              {kind === 'reflow' ? '原版' : '重排'}
            </button>
          ) : null}
          <button
            type="button"
            aria-pressed={activePanel === 'toc'}
            onClick={() => onTogglePanel('toc')}
          >
            目录
          </button>
          <button
            type="button"
            aria-pressed={activePanel === 'bookmarks'}
            onClick={onBookmark}
          >
            书签
          </button>
          <button
            type="button"
            aria-pressed={activePanel === 'annotations'}
            onClick={onNotes}
          >
            笔记
          </button>
          <button
            type="button"
            aria-pressed={activePanel === 'settings'}
            onClick={() => onTogglePanel('settings')}
          >
            设置
          </button>
          <button type="button" onClick={onFullscreen}>
            全屏
          </button>
        </nav>

        <span className="reader-sync" role="status" aria-live="polite">
          {SAVE_STATE_LABELS[saveState]}
        </span>
        <SyncStatusBadge className="reader-sync" />
      </header>

      <footer className="reader-chrome reader-chrome-bottom" onPointerDown={onActivity}>
        <button type="button" onClick={onPrevious}>
          上一页
        </button>

        <span className="reader-page-label">
          {kind === 'pdf' || kind === 'reflow'
            ? `第 ${safePage} / ${pageCount} 页`
            : `${percentValue}%`}
        </span>

        <input
          type="range"
          aria-label="阅读进度"
          className="reader-progress"
          min={0}
          max={100}
          step={1}
          value={percentValue}
          onChange={(event) => onSeekPercent(Number(event.target.value) / 100)}
        />

        {kind === 'pdf' || kind === 'reflow' ? (
          <span className="reader-page-jump">
            <input
              type="number"
              aria-label="页码"
              min={1}
              max={pageCount}
              value={pageText}
              onChange={(event) => setPageText(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  jumpToTypedPage();
                }
              }}
            />
            <button type="button" onClick={jumpToTypedPage}>
              跳转
            </button>
          </span>
        ) : null}

        <button type="button" onClick={onNext}>
          下一页
        </button>
      </footer>
    </>
  );
}
