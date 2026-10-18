import type { JSX } from 'react';
import { useEffect, useRef, useState } from 'react';
import type { AiThreadDto } from '@bookr/shared';
import { formatDate } from '../../../lib/format';

export interface AiThreadListProps {
  threads: AiThreadDto[];
  activeThreadId: string | null;
  onOpen(threadId: string): void;
  onRemove(threadId: string): void | Promise<void>;
}

const CONFIRM_TIMEOUT_MS = 3_000;

/** Saved conversations for this book, newest first, with a two-step delete. */
export function AiThreadList({
  threads,
  activeThreadId,
  onOpen,
  onRemove,
}: AiThreadListProps): JSX.Element {
  const [confirming, setConfirming] = useState<string | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (timer.current !== null) clearTimeout(timer.current);
    },
    [],
  );

  function clearTimer(): void {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  }

  function requestDelete(threadId: string): void {
    if (confirming === threadId) {
      clearTimer();
      setConfirming(null);
      void onRemove(threadId);
      return;
    }

    clearTimer();
    setConfirming(threadId);
    timer.current = setTimeout(() => {
      timer.current = null;
      setConfirming(null);
    }, CONFIRM_TIMEOUT_MS);
  }

  if (threads.length === 0) {
    return <p className="reader-panel-empty ai-thread-empty">还没有对话</p>;
  }

  return (
    <ul className="ai-threads" aria-label="历史对话">
      {threads.map((thread) => {
        const active = thread.id === activeThreadId;
        const confirmingThis = confirming === thread.id;
        return (
          <li key={thread.id} className="ai-thread" data-active={active ? 'true' : undefined}>
            <button
              type="button"
              className="ai-thread-target"
              aria-current={active ? 'true' : undefined}
              onClick={() => onOpen(thread.id)}
            >
              <span className="ai-thread-title">{thread.title}</span>
              <time className="ai-thread-date" dateTime={thread.updatedAt}>
                {formatDate(thread.updatedAt)}
              </time>
            </button>
            <button
              type="button"
              className="ai-thread-delete"
              aria-label={confirmingThis ? `确认删除 ${thread.title}` : `删除 ${thread.title}`}
              onClick={() => requestDelete(thread.id)}
            >
              {confirmingThis ? '确认删除？' : '删除'}
            </button>
          </li>
        );
      })}
    </ul>
  );
}
