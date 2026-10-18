import { useEffect } from 'react';

export interface ToastProps {
  message: string;
  onDismiss: () => void;
}

/** A quiet confirmation pinned above the shelf; disappears on its own. */
export function Toast({ message, onDismiss }: ToastProps) {
  useEffect(() => {
    const timer = window.setTimeout(onDismiss, 4000);
    return () => window.clearTimeout(timer);
  }, [message, onDismiss]);

  return (
    <div
      role="status"
      aria-live="polite"
      className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-md bg-ink px-4 py-2 text-sm tracking-wide text-paper shadow-lg"
    >
      {message}
    </div>
  );
}
