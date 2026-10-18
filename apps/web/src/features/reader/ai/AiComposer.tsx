import type { JSX } from 'react';
import { useState } from 'react';

export interface AiComposerProps {
  canSend: boolean;
  streaming: boolean;
  /** Resolves true when the exchange completed and the input can be cleared. */
  onSend(question: string): Promise<boolean>;
  onStop(): void;
}

/** The question box: Enter sends, Shift+Enter starts a new line. */
export function AiComposer({
  canSend,
  streaming,
  onSend,
  onStop,
}: AiComposerProps): JSX.Element {
  const [value, setValue] = useState('');
  const trimmed = value.trim();

  function submit(): void {
    if (!canSend || trimmed === '') return;
    void onSend(trimmed).then((sent) => {
      // A rejected exchange keeps the text so the reader can retry it.
      if (sent) setValue('');
    });
  }

  return (
    <div className="ai-composer">
      <textarea
        aria-label="向 AI 提问"
        className="ai-composer-input"
        rows={2}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        onKeyDown={(event) => {
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
