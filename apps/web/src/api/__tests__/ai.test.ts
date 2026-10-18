import { afterEach, expect, it, vi } from 'vitest';
import { setTokens } from '../client';
import { streamAiChat } from '../ai';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

const tokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token-which-is-long-enough',
  expiresIn: 900,
};

afterEach(() => {
  vi.unstubAllGlobals();
});

it('reads a stream and dispatches the AI events', async () => {
  setTokens(tokens);
  const fetchMock = vi.fn(async () => new Response(streamOf([
    'event: meta\ndata: {"threadId":"t1","userMessageId":"u1","assistantMessageId":"a1",',
    '"action":"explain","model":"deepseek-chat","promptVersion":"p5.1"}\n\n',
    'event: delta\ndata: {"text":"你好"}\n\n',
    'event: done\ndata: {"assistantMessageId":"a1","usage":{"promptTokens":3,"completionTokens":2},',
    '"quota":{"daily":{"used":5,"reserved":0,"limit":100},"monthly":{"used":5,"reserved":0,"limit":1000}}}\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetchMock);
  const handlers = {
    onMeta: vi.fn(), onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
  };

  await streamAiChat('book-1', {
    action: 'explain',
    selectedText: '一段话',
    context: { pageText: '本页' },
  }, handlers);

  expect(handlers.onMeta).toHaveBeenCalledWith(expect.objectContaining({ threadId: 't1' }));
  expect(handlers.onDelta).toHaveBeenCalledWith('你好');
  expect(handlers.onDone).toHaveBeenCalledWith(expect.objectContaining({ assistantMessageId: 'a1' }));
  expect(fetchMock).toHaveBeenCalledWith(
    '/api/books/book-1/ai/chat',
    expect.objectContaining({ method: 'POST' }),
  );
});

it('surfaces an error frame without throwing', async () => {
  setTokens(tokens);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf([
    'event: error\ndata: {"code":"AI_UPSTREAM_FAILED","message":"AI 服务暂时不可用，请稍后重试","retryable":true}\n\n',
  ]), { status: 200 })));
  const onError = vi.fn();
  await streamAiChat('book-1', { action: 'ask', question: '为什么？' }, {
    onMeta: vi.fn(), onDelta: vi.fn(), onDone: vi.fn(), onError,
  });
  expect(onError).toHaveBeenCalledWith(expect.objectContaining({ code: 'AI_UPSTREAM_FAILED' }));
});

it('turns a pre-stream HTTP failure into an ApiError', async () => {
  setTokens(tokens);
  vi.stubGlobal('fetch', vi.fn(async () => new Response(
    JSON.stringify({ error: { code: 'AI_QUOTA_EXCEEDED', message: '额度已用尽' } }),
    { status: 429, headers: { 'content-type': 'application/json' } },
  )));
  await expect(streamAiChat('book-1', { action: 'ask', question: '为什么？' }, {
    onMeta: vi.fn(), onDelta: vi.fn(), onDone: vi.fn(), onError: vi.fn(),
  })).rejects.toMatchObject({ status: 429, code: 'AI_QUOTA_EXCEEDED' });
});
