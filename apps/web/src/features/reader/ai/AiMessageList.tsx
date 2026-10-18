import type { JSX } from 'react';
import type { AiAction, AiMessageDto } from '@bookr/shared';

export interface AiMessageListProps {
  messages: AiMessageDto[];
}

const ACTION_LABELS: Record<AiAction, string> = {
  explain: '解释',
  summarize: '总结',
  ask: '提问',
};

/** The open transcript, with user quotes and assistant status markers. */
export function AiMessageList({ messages }: AiMessageListProps): JSX.Element {
  if (messages.length === 0) {
    return (
      <p className="reader-panel-empty ai-empty">
        选中一段文字点「解释」，或总结本页/本章
      </p>
    );
  }

  return (
    <ol className="ai-messages" aria-label="对话消息">
      {messages.map((message) => {
        if (message.role === 'user') {
          return (
            <li key={message.id} className="ai-message ai-message-user">
              {message.action ? (
                <span className="ai-action-label">{ACTION_LABELS[message.action]}</span>
              ) : null}
              {message.selectedText ? (
                <blockquote className="ai-quote">{message.selectedText}</blockquote>
              ) : null}
              {message.content ? (
                <p className="ai-message-content">{message.content}</p>
              ) : null}
            </li>
          );
        }

        return (
          <li
            key={message.id}
            className="ai-message ai-message-assistant"
            data-status={message.status}
          >
            <p className="ai-message-content ai-assistant-text">{message.content}</p>
            {message.status === 'streaming' ? (
              <span className="ai-cursor" aria-hidden="true" />
            ) : null}
            {message.status === 'interrupted' ? (
              <span className="ai-message-status">已停止</span>
            ) : null}
            {message.status === 'failed' ? (
              <span className="ai-message-status">未完成</span>
            ) : null}
          </li>
        );
      })}
    </ol>
  );
}
