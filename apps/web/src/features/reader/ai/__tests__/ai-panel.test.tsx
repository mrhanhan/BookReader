import { act, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import type { AiMessageDto, AiThreadDto } from '@bookr/shared';
import { AiPanel } from '../AiPanel';
import type { AiChatController } from '../useAiChat';

const messages: AiMessageDto[] = [
  {
    id: 'u1', threadId: 't1', role: 'user', content: '为什么要这样写？',
    status: 'complete', action: 'explain', selectedText: '程序由指令组成',
    model: null, promptTokens: 0, completionTokens: 0,
    createdAt: '2026-10-19T00:00:00.000Z',
  },
  {
    id: 'a1', threadId: 't1', role: 'assistant', content: '因为指令是执行单位。',
    status: 'complete', action: null, selectedText: null, model: 'fake-chat',
    promptTokens: 3, completionTokens: 5, createdAt: '2026-10-19T00:00:01.000Z',
  },
];

const thread: AiThreadDto = {
  id: 't1', bookId: 'book-1', title: '解释一段话', anchorLocator: null,
  messageCount: 2, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
};

const locator = { kind: 'pdf' as const, page: 2, percent: 0.2 };

function controller(overrides: Partial<AiChatController> = {}): AiChatController {
  return {
    threads: [], activeThread: null, messages: [], usage: {
      enabled: true, configured: true, fakeProvider: true, model: 'fake-chat',
      daily: { used: 1_234, reserved: 0, limit: 100_000 },
      monthly: { used: 12_345, reserved: 0, limit: 1_000_000 },
    },
    loading: false, streaming: false, error: null, disabledReason: null, canSend: true,
    openThread: vi.fn(), newThread: vi.fn(), explain: vi.fn(async () => true),
    summarize: vi.fn(async () => true), ask: vi.fn(async () => true),
    send: vi.fn(async () => true), stop: vi.fn(), retry: vi.fn(async () => true),
    removeThread: vi.fn(), refreshUsage: vi.fn(), dismissError: vi.fn(),
    ...overrides,
  };
}

it('renders messages, the quote and usage, and sends a follow-up', async () => {
  const ask = vi.fn(async () => true);
  render(<AiPanel controller={controller({ messages, ask })} offline={false} onClose={vi.fn()} />);

  const panel = screen.getByRole('complementary', { name: 'AI 伴读' });
  expect(within(panel).getByText('程序由指令组成')).toBeInTheDocument();
  expect(within(panel).getByText('因为指令是执行单位。')).toBeInTheDocument();
  expect(within(panel).getByText(/今日 1,234 \/ 100,000/)).toBeInTheDocument();

  await userEvent.type(within(panel).getByLabelText('向 AI 提问'), '再展开一点{Enter}');
  expect(ask).toHaveBeenCalledWith('再展开一点');
});

it('offers summaries and explains disabled states', async () => {
  const summarize = vi.fn(async () => true);
  render(<AiPanel controller={controller({ summarize })} offline={false} onClose={vi.fn()} />);
  await userEvent.click(screen.getByRole('button', { name: '总结本页' }));
  expect(summarize).toHaveBeenCalledWith('page');
  await userEvent.click(screen.getByRole('button', { name: '总结本章' }));
  expect(summarize).toHaveBeenCalledWith('chapter');

  render(<AiPanel controller={controller({ disabledReason: 'offline', canSend: false })} offline onClose={vi.fn()} />);
  expect(screen.getByText('离线时 AI 不可用，联网后自动恢复')).toBeInTheDocument();
});

it('starts a new conversation and closes from the header', async () => {
  const newThread = vi.fn();
  const onClose = vi.fn();
  render(<AiPanel controller={controller({ newThread })} offline={false} onClose={onClose} />);
  await userEvent.click(screen.getByRole('button', { name: '新对话' }));
  expect(newThread).toHaveBeenCalled();
  await userEvent.click(screen.getByRole('button', { name: '关闭' }));
  expect(onClose).toHaveBeenCalled();
});

it('shows every disabled hint and the empty state', () => {
  const cases = [
    ['offline', '离线时 AI 不可用，联网后自动恢复'],
    ['disabled', 'AI 伴读已在设置中关闭'],
    ['unconfigured', 'AI 尚未配置，请联系管理员'],
    ['quota', '今日或本月额度已用尽，额度会按用户时区重置'],
  ] as const;

  for (const [reason, hint] of cases) {
    const view = render(
      <AiPanel controller={controller({ disabledReason: reason, canSend: false })} offline={false} onClose={vi.fn()} />,
    );
    expect(screen.getByText(hint)).toBeInTheDocument();
    view.unmount();
  }

  render(<AiPanel controller={controller()} offline={false} onClose={vi.fn()} />);
  expect(screen.getByText('选中一段文字点「解释」，或总结本页/本章')).toBeInTheDocument();
});

it('shows the error bar with retry and dismiss', async () => {
  const retry = vi.fn(async () => true);
  const dismissError = vi.fn();
  render(
    <AiPanel
      controller={controller({ error: 'AI 服务暂时不可用，请稍后重试', retry, dismissError })}
      offline={false}
      onClose={vi.fn()}
    />,
  );

  const alert = screen.getByRole('alert');
  expect(alert).toHaveTextContent('AI 服务暂时不可用，请稍后重试');
  await userEvent.click(within(alert).getByRole('button', { name: '重试' }));
  expect(retry).toHaveBeenCalled();
  await userEvent.click(within(alert).getByRole('button', { name: '关闭错误' }));
  expect(dismissError).toHaveBeenCalled();
});

it('shows message states and a stop control while streaming', async () => {
  const stop = vi.fn();
  const streamed: AiMessageDto[] = [
    { ...messages[1]!, id: 'a2', content: '半句', status: 'interrupted' },
    { ...messages[1]!, id: 'a3', content: '失败内容', status: 'failed' },
    { ...messages[1]!, id: 'a4', content: '正在写', status: 'streaming' },
  ];
  render(
    <AiPanel
      controller={controller({ messages: streamed, streaming: true, canSend: false, stop })}
      offline={false}
      onClose={vi.fn()}
    />,
  );

  expect(screen.getByText('已停止')).toBeInTheDocument();
  expect(screen.getByText('未完成')).toBeInTheDocument();
  expect(screen.getByText('正在写')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '发送' })).not.toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '停止' }));
  expect(stop).toHaveBeenCalled();
});

it('sends a pending quote with the question and clears it on success', async () => {
  const ask = vi.fn(async () => true);
  const onClearPending = vi.fn();
  render(
    <AiPanel
      controller={controller({ ask })}
      offline={false}
      onClose={vi.fn()}
      pendingSelection={{ text: '选中文字', locator }}
      onClearPending={onClearPending}
    />,
  );

  expect(screen.getByText('选中文字')).toBeInTheDocument();
  await userEvent.type(screen.getByLabelText('向 AI 提问'), '为什么{Enter}');
  expect(ask).toHaveBeenCalledWith('为什么', { text: '选中文字', locator });
  await waitFor(() => expect(onClearPending).toHaveBeenCalled());
});

it('keeps the question when sending fails', async () => {
  const ask = vi.fn(async () => false);
  render(<AiPanel controller={controller({ ask })} offline={false} onClose={vi.fn()} />);

  const input = screen.getByLabelText('向 AI 提问') as HTMLTextAreaElement;
  await userEvent.type(input, '失败的提问{Enter}');
  await waitFor(() => expect(input.value).toBe('失败的提问'));
});

it('confirms thread deletion in two clicks within three seconds', async () => {
  const removeThread = vi.fn(async () => undefined);
  render(
    <AiPanel
      controller={controller({ threads: [thread], activeThread: thread, removeThread })}
      offline={false}
      onClose={vi.fn()}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: '历史' }));
  await userEvent.click(screen.getByRole('button', { name: /^删除/ }));
  expect(screen.getByRole('button', { name: /^确认删除/ })).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: /^确认删除/ }));
  expect(removeThread).toHaveBeenCalledWith('t1');
});

it('reverts the delete confirmation after three seconds', () => {
  vi.useFakeTimers();
  try {
    render(
      <AiPanel
        controller={controller({ threads: [thread], activeThread: thread })}
        offline={false}
        onClose={vi.fn()}
      />,
    );

    fireEvent.click(screen.getByRole('button', { name: '历史' }));
    fireEvent.click(screen.getByRole('button', { name: /^删除/ }));
    expect(screen.getByRole('button', { name: /^确认删除/ })).toBeInTheDocument();

    act(() => {
      vi.advanceTimersByTime(3_000);
    });
    expect(screen.getByRole('button', { name: /^删除/ })).toBeInTheDocument();
  } finally {
    vi.useRealTimers();
  }
});
