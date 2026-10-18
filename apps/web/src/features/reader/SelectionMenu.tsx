import { HIGHLIGHT_HEX } from '@bookr/reader-core';
import type { ReaderSelection } from '@bookr/reader-core';
import type { AnnotationColor } from '@bookr/shared';
import { ANNOTATION_COLOR_OPTIONS } from './colors';

export interface SelectionMenuProps {
  selection: ReaderSelection;
  onHighlight: (color: AnnotationColor) => void;
  onNote: (color: AnnotationColor) => void;
  onCopy: () => void;
  onDismiss: () => void;
}

/** Approximate menu box used to keep the floating bar inside the viewport. */
const MENU_WIDTH = 300;
const MENU_HEIGHT = 46;
const MENU_GAP = 8;

function menuPosition(rect: ReaderSelection['rect']): { left: number; top: number } {
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;

  const centered = rect.left + rect.width / 2 - MENU_WIDTH / 2;
  const maxLeft = Math.max(MENU_GAP, viewportWidth - MENU_WIDTH - MENU_GAP);
  const left = Math.min(Math.max(MENU_GAP, centered), maxLeft);

  // Prefer the space above the selection; flip below when it would be clipped.
  const above = rect.top - MENU_HEIGHT - MENU_GAP;
  const below = rect.top + rect.height + MENU_GAP;
  const top =
    above >= MENU_GAP
      ? above
      : Math.min(Math.max(MENU_GAP, below), Math.max(MENU_GAP, viewportHeight - MENU_HEIGHT - MENU_GAP));

  return { left, top };
}

/**
 * Floating actions for the current text selection. Clicking a color saves a
 * highlight immediately; notes open the dialog in create mode.
 */
export function SelectionMenu({
  selection,
  onHighlight,
  onNote,
  onCopy,
  onDismiss,
}: SelectionMenuProps) {
  const { left, top } = menuPosition(selection.rect);

  return (
    <div
      className="reader-selection-menu"
      role="toolbar"
      aria-label="选中文字操作"
      style={{ left, top, position: 'fixed' }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      <div className="reader-selection-colors" role="group" aria-label="划线颜色">
        {ANNOTATION_COLOR_OPTIONS.map((option) => (
          <button
            key={option.color}
            type="button"
            className={`reader-selection-swatch reader-selection-swatch-${option.color}`}
            style={{ backgroundColor: HIGHLIGHT_HEX[option.color] }}
            aria-label={option.actionLabel}
            title={option.actionLabel}
            onClick={() => onHighlight(option.color)}
          />
        ))}
      </div>
      <button type="button" className="reader-selection-action" onClick={() => onNote('yellow')}>
        写批注
      </button>
      <button type="button" className="reader-selection-action" onClick={onCopy}>
        复制
      </button>
      <button
        type="button"
        className="reader-selection-action reader-selection-dismiss"
        aria-label="关闭选中菜单"
        onClick={onDismiss}
      >
        ×
      </button>
    </div>
  );
}
