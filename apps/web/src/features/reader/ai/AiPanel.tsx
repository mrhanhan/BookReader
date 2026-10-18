import { useState } from 'react';
import type { JSX } from 'react';
import type { Locator } from '@bookr/shared';
import { AiComposer } from './AiComposer';
import { AiMessageList } from './AiMessageList';
import { AiThreadList } from './AiThreadList';
import type { AiChatController, AiDisabledReason } from './useAiChat';

export interface AiPanelProps {
  controller: AiChatController;
  offline: boolean;
  onClose(): void;
  /** 选中「提问」后的引用；提交时随问题一起发送。 */
  pendingSelection?: { text: string; locator: Locator } | null;
  onClearPending?: () => void;
}

const DISABLED_HINTS: Record<Exclude<AiDisabledReason, null>, string> = {
  offline: '离线时 AI 不可用，联网后自动恢复',
  disabled: 'AI 伴读已在设置中关闭',
  unconfigured: 'AI 尚未配置，请联系管理员',
  quota: '今日或本月额度已用尽，额度会按用户时区重置',
};

/** The reader's AI companion: summaries, quotes and free-form questions. */
export function AiPanel({
  controller,
  offline,
  onClose,
  pendingSelection,
  onClearPending,
}: AiPanelProps): JSX.Element {
  const [showThreads, setShowThreads] = useState(false);
  const disabledReason = controller.disabledReason ?? (offline ? 'offline' : null);
  const disabledHint = disabledReason ? DISABLED_HINTS[disabledReason] : null;

  async function handleSend(question: string): Promise<boolean> {
    if (pendingSelection) {
      const sent = await controller.ask(question, pendingSelection);
      if (sent) onClearPending?.();
      return sent;
    }
    return controller.ask(question);
  }

  return (
    <aside
      className="reader-panel reader-ai ai-panel"
      role="complementary"
      aria-label="AI 伴读"
    >
      <header className="reader-panel-header">
        <h2 className="reader-panel-title">AI 伴读</h2>
        <div className="reader-panel-header-actions">
          <button type="button" className="reader-panel-add" onClick={() => controller.newThread()}>
            新对话
          </button>
          <button
            type="button"
            className="reader-panel-add"
            aria-pressed={showThreads}
            onClick={() => setShowThreads((visible) => !visible)}
          >
            历史
          </button>
          <button type="button" className="reader-panel-close" onClick={onClose}>
            关闭
          </button>
        </div>
      </header>

      <div className="ai-toolbar">
        <button
          type="button"
          className="ai-tool"
          onClick={() => void controller.summarize('page')}
          disabled={!controller.canSend}
        >
          总结本页
        </button>
        <button
          type="button"
          className="ai-tool"
          onClick={() => void controller.summarize('chapter')}
          disabled={!controller.canSend}
        >
          总结本章
        </button>
      </div>

      {showThreads ? (
        <AiThreadList
          threads={controller.threads}
          activeThreadId={controller.activeThread?.id ?? null}
          onOpen={(threadId) => void controller.openThread(threadId)}
          onRemove={(threadId) => controller.removeThread(threadId)}
        />
      ) : null}

      {controller.error ? (
        <div className="ai-error" role="alert">
          <span className="ai-error-text">{controller.error}</span>
          <button type="button" onClick={() => void controller.retry()}>
            重试
          </button>
          <button type="button" onClick={() => controller.dismissError()}>
            关闭
          </button>
        </div>
      ) : null}

      {disabledHint ? <p className="ai-disabled-hint">{disabledHint}</p> : null}

      {pendingSelection ? (
        <div className="ai-pending">
          <blockquote className="ai-quote ai-pending-quote">{pendingSelection.text}</blockquote>
          <button type="button" className="ai-pending-clear" onClick={() => onClearPending?.()}>
            移除
          </button>
        </div>
      ) : null}

      <AiMessageList messages={controller.messages} />

      <AiComposer
        canSend={controller.canSend}
        streaming={controller.streaming}
        onSend={handleSend}
        onStop={() => controller.stop()}
      />

      {controller.usage ? (
        <p className="ai-usage">
          {`今日 ${controller.usage.daily.used.toLocaleString('zh-CN')} / ${controller.usage.daily.limit.toLocaleString('zh-CN')} tokens · 本月 ${controller.usage.monthly.used.toLocaleString('zh-CN')} / ${controller.usage.monthly.limit.toLocaleString('zh-CN')} tokens`}
        </p>
      ) : null}
    </aside>
  );
}
