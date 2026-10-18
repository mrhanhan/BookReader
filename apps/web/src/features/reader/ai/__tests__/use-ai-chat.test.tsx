import { act, renderHook, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import type {
  AiAction,
  AiChatRequest,
  AiMessageDto,
  AiThreadDto,
  AiUsageDto,
} from '@bookr/shared';
import type { AiStreamHandlers } from '../../../../api/ai';
import { useAiChat, type AiApi } from '../useAiChat';

const usage: AiUsageDto = {
  enabled: true, configured: true, fakeProvider: true, model: 'fake-chat',
  daily: { used: 0, reserved: 0, limit: 100_000 },
  monthly: { used: 0, reserved: 0, limit: 1_000_000 },
};
const thread: AiThreadDto = {
  id: 'thread-1', bookId: 'book-1', title: '解释一段话', anchorLocator: null,
  messageCount: 0, createdAt: '2026-10-19T00:00:00.000Z', updatedAt: '2026-10-19T00:00:00.000Z',
};
const secondThread: AiThreadDto = { ...thread, id: 'thread-2', title: '第二个线程' };
const assistant: AiMessageDto = {
  id: 'assistant-1', threadId: 'thread-1', role: 'assistant', content: '回答',
  status: 'complete', action: null, selectedText: null, model: 'fake-chat',
  promptTokens: 3, completionTokens: 2, createdAt: '2026-10-19T00:00:00.000Z',
};

function metaFor(action: AiAction = 'ask') {
  return {
    threadId: 'thread-1', userMessageId: 'user-1', assistantMessageId: 'assistant-1',
    action, model: 'fake-chat', promptVersion: 'p5.1',
  };
}

const done = {
  assistantMessageId: 'assistant-1',
  usage: { promptTokens: 3, completionTokens: 2 },
  quota: {
    daily: { used: 5, reserved: 0, limit: 100_000 },
    monthly: { used: 5, reserved: 0, limit: 1_000_000 },
  },
};

function apiWith(overrides: Partial<AiApi> = {}): AiApi {
  return {
    fetchThreads: vi.fn(async () => []),
    fetchThread: vi.fn(async () => ({
      thread,
      messages: [{ ...assistant, id: 'user-1', role: 'user' as const, content: '问题' }, assistant],
    })),
    fetchUsage: vi.fn(async () => usage),
    deleteThread: vi.fn(async () => undefined),
    streamChat: vi.fn(async (_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers) => {
      handlers.onMeta(metaFor('explain'));
      handlers.onDelta('回答');
      handlers.onDone(done);
    }),
    ...overrides,
  };
}

const locator = { kind: 'pdf' as const, page: 2, percent: 0.2 };
const context = {
  getTextContext: vi.fn(async (scope: 'page' | 'chapter') => ({
    text: scope === 'page' ? '本页正文' : '本章正文',
    label: scope === 'page' ? '第 2 页' : '第一章',
  })),
  currentLocator: () => locator,
};

it('opens the latest thread and explains the selection with page context', async () => {
  const api = apiWith({ fetchThreads: vi.fn(async () => [thread]) });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(api.fetchThread).toHaveBeenCalledWith('thread-1'));

  await act(async () => {
    await result.current.explain({ text: '选中文字', locator });
  });
  expect(api.streamChat).toHaveBeenCalledWith(
    'book-1',
    expect.objectContaining({
      action: 'explain',
      selectedText: '选中文字',
      locator,
      context: { pageText: '本页正文' },
    }),
    expect.anything(),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
  await waitFor(() => expect(result.current.usage?.daily.used).toBe(5));
  expect(result.current.error).toBeNull();
});

it('blocks sending when the account disabled AI or the quota is exhausted', async () => {
  const disabled = apiWith({
    fetchUsage: vi.fn(async () => ({ ...usage, enabled: false, daily: { ...usage.daily, used: 100_000 } })),
  });
  const disabledHook = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api: disabled }));
  await waitFor(() => expect(disabledHook.result.current.disabledReason).toBe('disabled'));
  await act(async () => {
    expect(await disabledHook.result.current.ask('问题')).toBe(false);
  });
  expect(disabled.streamChat).not.toHaveBeenCalled();

  const exhausted = apiWith({
    fetchUsage: vi.fn(async () => ({ ...usage, daily: { ...usage.daily, used: 100_000 } })),
  });
  const exhaustedHook = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api: exhausted }));
  await waitFor(() => expect(exhaustedHook.result.current.disabledReason).toBe('quota'));
  expect(exhaustedHook.result.current.canSend).toBe(false);
});

it('shows a friendly error and keeps the question available for retry', async () => {
  const api = apiWith({
    streamChat: vi.fn(async (_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers) => {
      handlers.onMeta(metaFor('ask'));
      handlers.onDelta('半句');
      handlers.onError({
        code: 'AI_UPSTREAM_FAILED', message: 'AI 服务暂时不可用，请稍后重试', retryable: true,
      });
    }),
    fetchThread: vi.fn(async () => ({
      thread,
      messages: [
        { ...assistant, id: 'user-1', role: 'user' as const, content: '问题' },
        { ...assistant, status: 'failed' as const, content: '半句' },
      ],
    })),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    // 失败返回 false，输入框据此保留问题原文。
    expect(await result.current.ask('问题')).toBe(false);
  });
  expect(result.current.error).toContain('暂时不可用');
  await waitFor(() => expect(result.current.messages.at(-1)?.status).toBe('failed'));
  expect(result.current.canSend).toBe(true);
});

it('reports offline and aborts a running stream on stop', async () => {
  const offlineHook = renderHook(() => useAiChat({ bookId: 'book-1', offline: true, context, api: apiWith() }));
  await waitFor(() => expect(offlineHook.result.current.disabledReason).toBe('offline'));

  let captured: AbortSignal | undefined;
  const api = apiWith({
    streamChat: vi.fn((_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers, options?: { signal?: AbortSignal }) => {
      captured = options?.signal;
      handlers.onMeta(metaFor('ask'));
      return new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')));
      });
    }),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  act(() => { void result.current.ask('问题'); });
  await waitFor(() => expect(result.current.streaming).toBe(true));
  act(() => result.current.stop());
  await waitFor(() => expect(captured?.aborted).toBe(true));
  await waitFor(() => expect(result.current.streaming).toBe(false));
});

it('does not fetch anything without a book id', async () => {
  const api = apiWith();
  const { result } = renderHook(() => useAiChat({ bookId: '', offline: false, context, api }));
  await act(async () => {
    await Promise.resolve();
  });
  expect(api.fetchThreads).not.toHaveBeenCalled();
  expect(api.fetchUsage).not.toHaveBeenCalled();
  expect(result.current.loading).toBe(false);
});

it('reports an unreadable AI status and keeps sending disabled', async () => {
  const api = apiWith({
    fetchUsage: vi.fn(async () => {
      throw new Error('boom');
    }),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.error).toBe('无法读取 AI 状态，请稍后重试');
  expect(result.current.canSend).toBe(false);
  expect(result.current.usage).toBeNull();
});

it('keeps chatting when only the thread list fails', async () => {
  const api = apiWith({
    fetchThreads: vi.fn(async () => {
      throw new Error('boom');
    }),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.threads).toEqual([]);
  expect(result.current.canSend).toBe(true);
});

it('removes optimistic messages when the request fails before meta', async () => {
  const api = apiWith({
    streamChat: vi.fn(async () => {
      throw new TypeError('Failed to fetch');
    }),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    expect(await result.current.ask('问题')).toBe(false);
  });
  expect(result.current.messages).toEqual([]);
  expect(result.current.error).toBe('网络不可用，请检查网络后重试');
});

it('returns true on done and retries the last request inside the same thread', async () => {
  const bodies: AiChatRequest[] = [];
  let failFirst = true;
  const streamChat = vi.fn(async (_bookId: string, body: AiChatRequest, handlers: AiStreamHandlers) => {
    bodies.push(body);
    handlers.onMeta(metaFor('ask'));
    if (failFirst) {
      failFirst = false;
      handlers.onError({
        code: 'AI_UPSTREAM_FAILED', message: 'AI 服务暂时不可用，请稍后重试', retryable: true,
      });
      return;
    }
    handlers.onDelta('好');
    handlers.onDone(done);
  });
  const api = apiWith({ streamChat });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));

  await act(async () => {
    expect(await result.current.ask('问题')).toBe(false);
  });
  expect(bodies[0]?.threadId).toBeUndefined();

  await act(async () => {
    expect(await result.current.retry()).toBe(true);
  });
  expect(bodies[1]?.threadId).toBe('thread-1');
});

it('starts a new thread for a quoted question and follows up inside an open thread', async () => {
  const bodies: AiChatRequest[] = [];
  const streamChat = vi.fn(async (_bookId: string, body: AiChatRequest, handlers: AiStreamHandlers) => {
    bodies.push(body);
    handlers.onMeta(metaFor('ask'));
    handlers.onDone(done);
  });
  const api = apiWith({ fetchThreads: vi.fn(async () => [thread]), streamChat });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await waitFor(() => expect(result.current.activeThread?.id).toBe('thread-1'));

  await act(async () => {
    await result.current.ask('为什么', { text: '选中', locator });
  });
  expect(bodies[0]?.threadId).toBeUndefined();
  expect(bodies[0]?.selectedText).toBe('选中');
  expect(bodies[0]?.context).toEqual({ pageText: '本页正文' });

  await act(async () => {
    await result.current.ask('接着问');
  });
  expect(bodies[1]?.threadId).toBe('thread-1');
});

it('refuses to summarize when the page has no text', async () => {
  const emptyContext = {
    getTextContext: vi.fn(async () => ({ text: '', label: '第 2 页' })),
    currentLocator: () => locator,
  };
  const api = apiWith();
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context: emptyContext, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));
  await act(async () => {
    expect(await result.current.summarize('page')).toBe(false);
  });
  expect(result.current.error).toBe('暂时无法获取本页文字，请稍后再试');
  expect(api.streamChat).not.toHaveBeenCalled();
});

it('removes a thread and opens the next one when the active thread is deleted', async () => {
  const deleteThread = vi.fn(async () => undefined);
  const api = apiWith({
    fetchThreads: vi.fn(async () => [thread, secondThread]),
    fetchThread: vi.fn(async (threadId: string) =>
      threadId === 'thread-2'
        ? { thread: secondThread, messages: [] }
        : { thread, messages: [] },
    ),
    deleteThread,
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.activeThread?.id).toBe('thread-1'));

  await act(async () => {
    await result.current.removeThread('thread-1');
  });
  expect(deleteThread).toHaveBeenCalledWith('thread-1');
  expect(result.current.threads.map((item) => item.id)).toEqual(['thread-2']);
  await waitFor(() => expect(result.current.activeThread?.id).toBe('thread-2'));
});

it('recovers usage and threads after connectivity returns', async () => {
  const fetchUsage = vi
    .fn<() => Promise<AiUsageDto>>()
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValue(usage);
  const api = apiWith({
    fetchUsage,
    fetchThreads: vi.fn(async () => [thread]),
    fetchThread: vi.fn(async () => ({ thread, messages: [] })),
  });
  const { result, rerender } = renderHook(
    ({ offline }: { offline: boolean }) =>
      useAiChat({ bookId: 'book-1', offline, context, api }),
    { initialProps: { offline: true } },
  );

  await waitFor(() => expect(result.current.loading).toBe(false));
  expect(result.current.disabledReason).toBe('offline');

  rerender({ offline: false });
  await waitFor(() => expect(result.current.usage).toEqual(usage));
  await waitFor(() => expect(result.current.threads).toHaveLength(1));
  expect(result.current.error).toBeNull();
});

it('abandons the previous stream when starting a new thread', async () => {
  let handlers: AiStreamHandlers | null = null;
  const api = apiWith({
    streamChat: vi.fn((_bookId: string, _body: AiChatRequest, next: AiStreamHandlers, options?: { signal?: AbortSignal }) => {
      handlers = next;
      return new Promise<void>((_resolve, reject) => {
        options?.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      });
    }),
  });
  const { result } = renderHook(() => useAiChat({ bookId: 'book-1', offline: false, context, api }));
  await waitFor(() => expect(result.current.loading).toBe(false));

  act(() => {
    void result.current.ask('问题');
  });
  await waitFor(() => expect(result.current.streaming).toBe(true));

  act(() => {
    result.current.newThread();
  });
  expect(result.current.streaming).toBe(false);
  expect(result.current.messages).toHaveLength(0);

  // A late event from the abandoned stream must not repopulate the transcript.
  act(() => {
    handlers?.onMeta(metaFor('ask'));
    handlers?.onDelta('旧回答');
  });
  expect(result.current.messages).toHaveLength(0);
});
