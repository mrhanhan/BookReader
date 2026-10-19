import { http, HttpResponse } from 'msw';
import { afterEach, expect, it, vi } from 'vitest';
import { server } from '../../../test/setup';
import { SseProtocolError } from '../../lib/sse';
import {
  buildNotesQueryString,
  downloadNotesExport,
  fetchNoteTags,
  fetchNotes,
  filenameFromDisposition,
  streamNoteAnalysis,
} from '../notes';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

function emptyHandlers() {
  return {
    onMeta: vi.fn(),
    onDelta: vi.fn(),
    onDone: vi.fn(),
    onError: vi.fn(),
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

it('omits blank filters and trims the search term', () => {
  expect(buildNotesQueryString({ q: ' 狐狸 ', bookId: '', tag: undefined })).toBe(
    'q=%E7%8B%90%E7%8B%B8',
  );
});

it('includes paging only when asked', () => {
  expect(buildNotesQueryString({ page: 2, pageSize: 30 })).toBe('page=2&pageSize=30');
  expect(buildNotesQueryString({ q: '书' })).toBe('q=%E4%B9%A6');
});

it('parses the UTF-8 export filename', () => {
  expect(
    filenameFromDisposition(
      `attachment; filename="notes.md"; filename*=UTF-8''%E7%AC%94%E8%AE%B0.md`,
    ),
  ).toBe('笔记.md');
  expect(filenameFromDisposition('attachment; filename="笔记.md"')).toBe('笔记.md');
  expect(filenameFromDisposition(null)).toBeNull();
});

it('downloads the export as a blob with its filename', async () => {
  server.use(
    http.get('/api/notes/export', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('q') !== '狐狸') return new HttpResponse(null, { status: 400 });
      return new HttpResponse('# 狐狸笔记\n', {
        status: 200,
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="notes.md"; filename*=UTF-8''%E7%AC%94%E8%AE%B0.md`,
        },
      });
    }),
  );

  const { blob, filename } = await downloadNotesExport({ q: ' 狐狸 ' });

  expect(filename).toBe('笔记.md');
  expect(await blob.text()).toBe('# 狐狸笔记\n');
});

it('lists notes through the shared query string', async () => {
  server.use(
    http.get('/api/notes', ({ request }) => {
      const url = new URL(request.url);
      if (url.searchParams.get('tag') !== '方法论') return new HttpResponse(null, { status: 400 });
      return HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 30 });
    }),
    http.get('/api/notes/tags', () =>
      HttpResponse.json({ items: [{ tag: '方法论', count: 2 }] }),
    ),
  );

  await expect(fetchNotes({ tag: '方法论' })).resolves.toMatchObject({ total: 0 });
  await expect(fetchNoteTags()).resolves.toEqual([{ tag: '方法论', count: 2 }]);
});

it('streams analysis frames in order', async () => {
  const fetchMock = vi.fn(async () => new Response(streamOf([
    'event: meta\ndata: {"analysisId":"a1","kind":"themes","model":"deepseek-chat",',
    '"promptVersion":"p6.1","noteCount":3,"analyzedCount":2}\n\n',
    'event: delta\ndata: {"text":"主题"}\n\n',
    'event: delta\ndata: {"text":"线索"}\n\n',
    'event: ping\ndata: {"ignored":true}\n\n',
    'event: done\ndata: {"analysisId":"a1","usage":{"promptTokens":10,"completionTokens":4},',
    '"quota":{"daily":{"used":1,"reserved":0,"limit":100},"monthly":{"used":1,"reserved":0,"limit":1000}}}\n\n',
  ]), { status: 200, headers: { 'content-type': 'text/event-stream' } }));
  vi.stubGlobal('fetch', fetchMock);
  const handlers = emptyHandlers();

  await streamNoteAnalysis({ kind: 'themes', filters: { tag: '方法论' } }, handlers);

  expect(fetchMock).toHaveBeenCalledWith(
    '/api/notes/analyses',
    expect.objectContaining({
      method: 'POST',
      body: JSON.stringify({ kind: 'themes', filters: { tag: '方法论' } }),
    }),
  );

  const order = [
    handlers.onMeta.mock.calls.length,
    handlers.onDelta.mock.calls.length,
    handlers.onDone.mock.calls.length,
    handlers.onError.mock.calls.length,
  ];
  expect(order).toEqual([1, 2, 1, 0]);
  expect(handlers.onMeta).toHaveBeenCalledWith(
    expect.objectContaining({ analysisId: 'a1', kind: 'themes' }),
  );
  expect(handlers.onDelta.mock.calls.map(([text]) => text)).toEqual(['主题', '线索']);
  expect(handlers.onDone).toHaveBeenCalledWith(expect.objectContaining({ analysisId: 'a1' }));
  expect(handlers.onMeta.mock.invocationCallOrder[0]).toBeLessThan(
    handlers.onDelta.mock.invocationCallOrder[0] as number,
  );
  expect(handlers.onDelta.mock.invocationCallOrder[1]).toBeLessThan(
    handlers.onDone.mock.invocationCallOrder[0] as number,
  );
});

it('delivers an error frame without throwing', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf([
    'event: error\ndata: {"code":"AI_UPSTREAM_FAILED","message":"AI 服务暂时不可用，请稍后重试","retryable":true}\n\n',
  ]), { status: 200 })));
  const handlers = emptyHandlers();

  await expect(streamNoteAnalysis({ kind: 'todos' }, handlers)).resolves.toBeUndefined();

  expect(handlers.onError).toHaveBeenCalledWith({
    code: 'AI_UPSTREAM_FAILED',
    message: 'AI 服务暂时不可用，请稍后重试',
    retryable: true,
  });
  expect(handlers.onDone).not.toHaveBeenCalled();
});

it('rejects a malformed frame payload', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf([
    'event: delta\ndata: {not json}\n\n',
  ]), { status: 200 })));

  await expect(streamNoteAnalysis({ kind: 'themes' }, emptyHandlers())).rejects.toThrow(
    SseProtocolError,
  );
});

it('rejects a response without a body', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(null, { status: 200 })));

  await expect(streamNoteAnalysis({ kind: 'themes' }, emptyHandlers())).rejects.toThrow(
    SseProtocolError,
  );
});

it('rejects an incomplete stream', async () => {
  vi.stubGlobal('fetch', vi.fn(async () => new Response(streamOf([
    'event: meta\ndata: {"analysisId":"a1","kind":"viewpoints","model":"deepseek-chat",',
    '"promptVersion":"p6.1","noteCount":3,"analyzedCount":3}\n\n',
  ]), { status: 200 })));
  const handlers = emptyHandlers();

  await expect(streamNoteAnalysis({ kind: 'viewpoints' }, handlers)).rejects.toThrow(
    SseProtocolError,
  );
  await expect(streamNoteAnalysis({ kind: 'viewpoints' }, emptyHandlers())).rejects.toThrow(
    'AI 流意外结束',
  );
  expect(handlers.onDone).not.toHaveBeenCalled();
  expect(handlers.onError).not.toHaveBeenCalled();
});

it('rethrows AbortError when the caller stops the stream', async () => {
  const controller = new AbortController();
  controller.abort();
  vi.stubGlobal('fetch', vi.fn(async () => new Response(new ReadableStream<Uint8Array>({
    start(streamController) {
      streamController.error(new DOMException('The operation was aborted.', 'AbortError'));
    },
  }))));

  await expect(
    streamNoteAnalysis({ kind: 'themes' }, emptyHandlers(), { signal: controller.signal }),
  ).rejects.toMatchObject({ name: 'AbortError' });
});
