import type { JSX } from 'react';
import { useState } from 'react';
import { AI_MAX_QUESTION_LENGTH } from '@bookr/shared';

export interface AiComposerProps {
  canSend: boolean;
  streaming: boolean;
  /** Resolves true when the exchange completed and the input can be cleared. */
  onSend(question: string): Promise<boolean>;
  onStop(): void;
  onClose?(): void;
}

/** The question box: Enter sends, Shift+Enter starts a new line. */
export function AiComposer({
  canSend,
  streaming,
  onSend,
  onStop,
  onClose,
}: AiComposerProps): JSX.Element {
  const [value, setValue] = useState('');
  const trimmed = value.trim();

  function submit(): void {
    if (!canSend || trimmed === '') return;
    const sentText = value;
    void onSend(trimmed).then((sent) => {
      // A rejected exchange keeps the text so the reader can retry it; typing
      // while the request was in flight must not be discarded.
      if (sent) setValue((current) => (current === sentText ? '' : current));
    });
  }

  return (
    <div className="ai-composer">
      <textarea
        aria-label="向 AI 提问"
        className="ai-composer-input"
        rows={2}
        maxLength={AI_MAX_QUESTION_LENGTH}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            onClose?.();
            return;
          }
          if (event.key === 'Enter' && !event.shiftKey) {
            event.preventDefault();
            submit();
          }
        }}
      />
      {streaming ? (
        <button type="button" className="ai-composer-send" onClick={onStop}>
          停止
        </button>
      ) : (
        <button
          type="button"
          className="ai-composer-send"
          onClick={submit}
          disabled={!canSend || trimmed === ''}
        >
          发送
        </button>
      )}
    </div>
  );
}
