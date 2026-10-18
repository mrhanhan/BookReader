import { useState } from 'react';
import type { BookmarkDto } from '@bookr/shared';
import { Button, Dialog } from '@bookr/ui';
import { formatDate } from '../../lib/format';

export interface BookmarksPanelProps {
  bookmarks: BookmarkDto[];
  /** Opens the bookmark dialog with the current position. */
  onAdd: () => void;
  onJump: (bookmark: BookmarkDto) => void;
  onRename: (bookmark: BookmarkDto) => void;
  onDelete: (bookmark: BookmarkDto) => void;
  onClose: () => void;
}

/** The label shown for a bookmark: its note, or a page/position fallback. */
export function bookmarkTitle(bookmark: BookmarkDto): string {
  if (bookmark.label) return bookmark.label;
  const locator = bookmark.locator;
  if (locator.kind === 'pdf') return `第 ${locator.page} 页`;
  return `位置 ${Math.round(locator.percent * 100)}%`;
}

/** Saved reading positions with jump, rename and delete actions. */
export function BookmarksPanel({
  bookmarks,
  onAdd,
  onJump,
  onRename,
  onDelete,
  onClose,
}: BookmarksPanelProps) {
  const [deleting, setDeleting] = useState<BookmarkDto | null>(null);

  function confirmDelete(): void {
    const target = deleting;
    setDeleting(null);
    if (target) onDelete(target);
  }

  return (
    <aside className="reader-panel reader-bookmarks" aria-label="书签">
      <header className="reader-panel-header">
        <h2 className="reader-panel-title">书签</h2>
        <div className="reader-panel-header-actions">
          <button type="button" className="reader-panel-add" onClick={onAdd}>
            添加书签
          </button>
          <button type="button" className="reader-panel-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>

      {bookmarks.length === 0 ? (
        <p className="reader-panel-empty">还没有书签</p>
      ) : (
        <ul className="reader-bookmark-list">
          {bookmarks.map((bookmark) => (
            <li key={bookmark.id} data-testid="bookmark-item" className="reader-bookmark">
              <button
                type="button"
                className="reader-bookmark-target"
                onClick={() => onJump(bookmark)}
              >
                <span className="reader-bookmark-label">{bookmarkTitle(bookmark)}</span>
              </button>
              <div className="reader-bookmark-meta">
                <time dateTime={bookmark.createdAt}>{formatDate(bookmark.createdAt)}</time>
                <div className="reader-bookmark-actions">
                  <button
                    type="button"
                    aria-label={`跳转：${bookmarkTitle(bookmark)}`}
                    onClick={() => onJump(bookmark)}
                  >
                    跳转
                  </button>
                  <button
                    type="button"
                    aria-label={`重命名：${bookmarkTitle(bookmark)}`}
                    onClick={() => onRename(bookmark)}
                  >
                    重命名
                  </button>
                  <button
                    type="button"
                    aria-label={`删除：${bookmarkTitle(bookmark)}`}
                    onClick={() => setDeleting(bookmark)}
                  >
                    删除
                  </button>
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      {deleting ? (
        <Dialog
          open
          onClose={() => setDeleting(null)}
          title="删除书签"
          footer={
            <>
              <Button variant="ghost" onClick={() => setDeleting(null)}>
                取消
              </Button>
              <Button variant="danger" onClick={confirmDelete}>
                确认删除
              </Button>
            </>
          }
        >
          <p className="text-sm leading-6 text-ink">确定删除这个书签吗？</p>
        </Dialog>
      ) : null}
    </aside>
  );
}
