import { useLayoutEffect, useRef, useState } from 'react';
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

/** First-render estimate, replaced by the measured box in a layout effect. */
const FALLBACK_SIZE = { width: 300, height: 46 };
const MENU_GAP = 8;

interface MenuSize {
  width: number;
  height: number;
}

function menuPosition(
  rect: ReaderSelection['rect'],
  size: MenuSize,
): { left: number; top: number } {
  const viewportWidth = typeof window === 'undefined' ? 1024 : window.innerWidth;
  const viewportHeight = typeof window === 'undefined' ? 768 : window.innerHeight;

  const centered = rect.left + rect.width / 2 - size.width / 2;
  const maxLeft = Math.max(MENU_GAP, viewportWidth - size.width - MENU_GAP);
  const left = Math.min(Math.max(MENU_GAP, centered), maxLeft);

  // Prefer the space above the selection; flip below when it would be clipped.
  const above = rect.top - size.height - MENU_GAP;
  const below = rect.top + rect.height + MENU_GAP;
  const top =
    above >= MENU_GAP
      ? above
      : Math.min(
          Math.max(MENU_GAP, below),
          Math.max(MENU_GAP, viewportHeight - size.height - MENU_GAP),
        );

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
  const menuRef = useRef<HTMLDivElement | null>(null);
  const [size, setSize] = useState<MenuSize>(FALLBACK_SIZE);

  // Measure the real toolbar (its width depends on fonts and labels) so the
  // viewport clamp and the top flip use actual dimensions.
  useLayoutEffect(() => {
    const element = menuRef.current;
    if (!element) return;
    const measured = element.getBoundingClientRect();
    if (measured.width > 0 && measured.height > 0) {
      setSize({ width: measured.width, height: measured.height });
    }
  }, [selection]);

  const { left, top } = menuPosition(selection.rect, size);

  return (
    <div
      ref={menuRef}
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
