import type { MouseEventHandler, Ref } from 'react';

export interface ReaderContentProps {
  /** The engine appends its own scroll host (PDF) or iframe (EPUB) here. */
  containerRef: Ref<HTMLDivElement>;
  onTap?: MouseEventHandler<HTMLDivElement>;
}

/**
 * The reading surface. Its only child is whatever the engine builds, so React
 * never touches the engine-owned DOM.
 */
export function ReaderContent({ containerRef, onTap }: ReaderContentProps) {
  return (
    <div
      ref={containerRef}
      className="reader-content"
      data-testid="reader-content"
      onClick={onTap}
    />
  );
}
