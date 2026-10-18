import { useState } from 'react';
import { HIGHLIGHT_HEX } from '@bookr/reader-core';
import type { AnnotationDto } from '@bookr/shared';
import { Button, Dialog } from '@bookr/ui';
import { formatDate } from '../../lib/format';

export interface AnnotationsPanelProps {
  annotations: AnnotationDto[];
  onJump: (annotation: AnnotationDto) => void;
  onEdit: (annotation: AnnotationDto) => void;
  onDelete: (annotation: AnnotationDto) => void;
  onClose: () => void;
}

function excerpt(text: string, max = 120): string {
  const compact = text.replace(/\s+/g, ' ').trim();
  return compact.length <= max ? compact : `${compact.slice(0, max)}…`;
}

/** Short name used to make each row's action buttons distinguishable. */
function subject(annotation: AnnotationDto): string {
  return excerpt(annotation.noteText ?? annotation.selectedText, 24);
}

/** The reader's own highlights and notes, newest edit first. */
export function AnnotationsPanel({
  annotations,
  onJump,
  onEdit,
  onDelete,
  onClose,
}: AnnotationsPanelProps) {
  const [deleting, setDeleting] = useState<AnnotationDto | null>(null);

  function confirmDelete(): void {
    const target = deleting;
    setDeleting(null);
    if (target) onDelete(target);
  }

  return (
    <aside className="reader-panel reader-annotations" aria-label="笔记">
      <header className="reader-panel-header">
        <h2 className="reader-panel-title">笔记</h2>
        <button type="button" className="reader-panel-close" onClick={onClose}>
          关闭
        </button>
      </header>

      {annotations.length === 0 ? (
        <p className="reader-panel-empty">还没有划线和批注</p>
      ) : (
        <ul className="reader-annotation-list">
          {annotations.map((annotation) => (
            <li
              key={annotation.id}
              data-testid="annotation-item"
              className="reader-annotation"
            >
              <span
                className="reader-annotation-color"
                style={{ backgroundColor: HIGHLIGHT_HEX[annotation.color] }}
                aria-hidden="true"
              />
              <div className="reader-annotation-main">
                <button
                  type="button"
                  className="reader-annotation-target"
                  onClick={() => onJump(annotation)}
                >
                  <span className="reader-annotation-selected">
                    {excerpt(annotation.selectedText)}
                  </span>
                  {annotation.noteText ? (
                    <span className="reader-annotation-note">{annotation.noteText}</span>
                  ) : null}
                </button>

                {annotation.tags.length > 0 ? (
                  <ul className="reader-annotation-tags" aria-label="标签">
                    {annotation.tags.map((tag) => (
                      <li key={tag} className="reader-annotation-tag">
                        {tag}
                      </li>
                    ))}
                  </ul>
                ) : null}

                <div className="reader-annotation-meta">
                  <time dateTime={annotation.updatedAt}>
                    {formatDate(annotation.updatedAt)}
                  </time>
                  <div className="reader-annotation-actions">
                    <button
                      type="button"
                      aria-label={`跳转：${subject(annotation)}`}
                      onClick={() => onJump(annotation)}
                    >
                      跳转
                    </button>
                    <button
                      type="button"
                      aria-label={`编辑：${subject(annotation)}`}
                      onClick={() => onEdit(annotation)}
                    >
                      编辑
                    </button>
                    <button
                      type="button"
                      aria-label={`删除：${subject(annotation)}`}
                      onClick={() => setDeleting(annotation)}
                    >
                      删除
                    </button>
                  </div>
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
          title="删除批注"
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
          <p className="text-sm leading-6 text-ink">确定删除这条划线或批注吗？删除后无法恢复。</p>
        </Dialog>
      ) : null}
    </aside>
  );
}
