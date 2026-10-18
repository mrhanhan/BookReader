import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { AiChatRequest, AiUsageDto } from '@bookr/shared';
import type { AiStreamHandlers } from '../../../api/ai';
import { setTokens } from '../../../api/client';
import { ReaderPage } from '../ReaderPage';
import { createFakeEngine } from './fake-engine';
import { createFakeSyncEngine, createMemoryRepository } from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';

const usage: AiUsageDto = {
  enabled: true, configured: true, fakeProvider: true, model: 'fake-chat',
  daily: { used: 0, reserved: 0, limit: 100_000 },
  monthly: { used: 0, reserved: 0, limit: 1_000_000 },
};

function aiApi(streamChat = vi.fn(async (_bookId: string, _body: AiChatRequest, handlers: AiStreamHandlers) => {
  handlers.onMeta({
    threadId: 't1', userMessageId: 'u1', assistantMessageId: 'a1',
    action: 'explain', model: 'fake-chat', promptVersion: 'p5.1',
  });
  handlers.onDelta('这是解释。');
  handlers.onDone({
    assistantMessageId: 'a1',
    usage: { promptTokens: 3, completionTokens: 4 },
    quota: { daily: { used: 7, reserved: 0, limit: 100_000 }, monthly: usage.monthly },
  });
})) {
  return {
    fetchThreads: vi.fn(async () => []),
    fetchThread: vi.fn(async () => ({
      thread: {
        id: 't1', bookId: 'book-csapp', title: '解释', anchorLocator: null,
        messageCount: 2, createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
      },
      messages: [],
    })),
    fetchUsage: vi.fn(async () => usage),
    deleteThread: vi.fn(async () => undefined),
    streamChat,
  };
}

function renderReader(api = aiApi()) {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = createFakeEngine('pdf');
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} aiApi={api} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, {
    repo: createMemoryRepository(), engine: createFakeSyncEngine(),
  });
  return { engine, api };
}

it('explains a selection with the current page context', async () => {
  const { engine, api } = renderReader();
  await screen.findByRole('heading', { name: '深入理解计算机系统' });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '选中文字',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 10, top: 10, width: 100, height: 20 },
  });
  expect(await screen.findByRole('button', { name: '总结本页' })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '解释' }));

  await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
  expect(api.streamChat.mock.calls[0]![1]).toMatchObject({
    action: 'explain',
    selectedText: '选中文字',
    context: { pageText: '模拟本页正文' },
  });
  expect(await screen.findByRole('complementary', { name: 'AI 伴读' })).toBeInTheDocument();
});

it('asks a question about the selection from the panel composer', async () => {
  const { engine, api } = renderReader();
  await screen.findByRole('heading', { name: '深入理解计算机系统' });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '程序由指令组成',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 10, top: 10, width: 100, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '提问' }));
  const panel = await screen.findByRole('complementary', { name: 'AI 伴读' });
  expect(panel).toHaveTextContent('程序由指令组成');

  await userEvent.type(screen.getByLabelText('向 AI 提问'), '为什么？{Enter}');
  await waitFor(() => expect(api.streamChat).toHaveBeenCalled());
  expect(api.streamChat.mock.calls[0]![1]).toMatchObject({
    action: 'ask',
    question: '为什么？',
    selectedText: '程序由指令组成',
  });
});

it('shows the offline notice when the network drops', async () => {
  const { engine } = renderReader();
  await screen.findByRole('heading', { name: '深入理解计算机系统' });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
  window.dispatchEvent(new Event('offline'));
  await userEvent.click(screen.getByRole('button', { name: 'AI' }));

  expect(await screen.findByText('离线时 AI 不可用，联网后自动恢复')).toBeInTheDocument();
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  window.dispatchEvent(new Event('online'));
});
