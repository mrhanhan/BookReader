import { useEffect, useRef } from 'react';
import type { ReactNode } from 'react';
import { cn } from '../cn';

export interface DialogProps {
  open: boolean;
  onClose: () => void;
  title: string;
  children: ReactNode;
  footer?: ReactNode;
  className?: string;
}

export function Dialog({ open, onClose, title, children, footer, className }: DialogProps) {
  const ref = useRef<HTMLDialogElement>(null);

  useEffect(() => {
    const dialog = ref.current;
    if (!dialog) return;

    if (open && !dialog.open) {
      if (typeof dialog.showModal === 'function') {
        dialog.showModal();
      } else {
        // Older jsdom builds expose <dialog> without the modal API.
        dialog.setAttribute('open', '');
      }
    } else if (!open && dialog.open) {
      if (typeof dialog.close === 'function') {
        dialog.close();
      } else {
        // jsdom reflects the `open` attribute without implementing close().
        dialog.removeAttribute('open');
      }
    }
  }, [open]);

  return (
    <dialog
      ref={ref}
      onCancel={(event) => {
        // Escape already closes the native dialog; keep React state in sync.
        event.preventDefault();
        onClose();
      }}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
      className={cn(
        'm-auto w-[min(32rem,calc(100vw-2rem))] rounded-lg border border-border bg-surface p-0 text-ink shadow-xl',
        'max-h-[calc(100dvh-2rem)] overflow-y-auto',
        // Phones get a bottom sheet: full width, anchored to the bottom edge,
        // so long forms stay reachable with one thumb.
        'max-sm:mb-0 max-sm:w-full max-sm:max-w-none max-sm:rounded-b-none max-sm:border-x-0 max-sm:border-b-0 max-sm:max-h-[min(90dvh,calc(100dvh-0.5rem))]',
        className,
      )}
    >
      <div className="flex items-start justify-between gap-4 border-b border-border px-5 py-4">
        <h2 className="text-lg text-ink">{title}</h2>
        <button
          type="button"
          onClick={onClose}
          aria-label="关闭"
          className="rounded p-1 text-muted transition hover:bg-ink/5 hover:text-ink"
        >
          ×
        </button>
      </div>
      <div className="px-5 py-4">{children}</div>
      {footer ? (
        <div className="flex justify-end gap-2 border-t border-border px-5 py-3">{footer}</div>
      ) : null}
    </dialog>
  );
}
