import type { TocItem } from '@bookr/reader-core';

export interface TocPanelProps {
  toc: TocItem[];
  onSelect: (item: TocItem) => void;
  onClose: () => void;
}

/** Flat table of contents; nesting is conveyed with an indented padding. */
export function TocPanel({ toc, onSelect, onClose }: TocPanelProps) {
  return (
    <aside className="reader-panel reader-toc" aria-label="目录">
      <header className="reader-panel-header">
        <h2 className="reader-panel-title">目录</h2>
        <button type="button" className="reader-panel-close" onClick={onClose}>
          关闭
        </button>
      </header>

      {toc.length === 0 ? (
        <p className="reader-panel-empty">暂无目录</p>
      ) : (
        <ul className="reader-toc-list">
          {toc.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                className="reader-toc-item"
                style={{ paddingLeft: `${item.depth * 12}px` }}
                onClick={() => onSelect(item)}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      )}
    </aside>
  );
}
