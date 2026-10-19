import type {
  AiChatRequest,
  AiMessageDto,
  AiStreamDone,
  AiStreamErrorPayload,
  AiStreamMeta,
  AiThreadDto,
  AiUsageDto,
} from '@bookr/shared';
import { readSseStream, SseProtocolError } from '../lib/sse';
import { apiFetch, authorizedFetch } from './client';

/** Current AI availability, model and quota snapshot. */
export function fetchAiUsage(): Promise<AiUsageDto> {
  return apiFetch<AiUsageDto>('/api/ai/usage');
}

/** Threads anchored to a book, newest first. */
export async function fetchAiThreads(bookId: string): Promise<AiThreadDto[]> {
  const { items } = await apiFetch<{ items: AiThreadDto[] }>(
    `/api/books/${bookId}/ai/threads`,
  );
  return items;
}

/** One thread and its full transcript. */
export function fetchAiThread(
  threadId: string,
): Promise<{ thread: AiThreadDto; messages: AiMessageDto[] }> {
  return apiFetch<{ thread: AiThreadDto; messages: AiMessageDto[] }>(
    `/api/ai/threads/${threadId}`,
  );
}

export function deleteAiThread(threadId: string): Promise<void> {
  return apiFetch<void>(`/api/ai/threads/${threadId}`, { method: 'DELETE' });
}

/** Toggles the member-level AI switch and returns the stored value. */
export async function setAiEnabled(enabled: boolean): Promise<boolean> {
  const result = await apiFetch<{ enabled: boolean }>('/api/me/ai', {
    method: 'PATCH',
    body: JSON.stringify({ enabled }),
  });
  return result.enabled;
}

/** Callbacks invoked as the chat stream progresses. */
export interface AiStreamHandlers {
  onMeta(meta: AiStreamMeta): void;
  onDelta(text: string): void;
  onDone(done: AiStreamDone): void;
  onError(payload: AiStreamErrorPayload): void;
}

function parseFrame<T>(data: string): T {
  try {
    return JSON.parse(data) as T;
  } catch {
    throw new SseProtocolError('AI 流数据格式错误');
  }
}

/**
 * Streams one chat exchange. An `error` frame is delivered to `onError` and
 * ends normally; only transport, protocol and HTTP failures reject. An aborted
 * signal keeps its `AbortError` so the caller can distinguish "user stopped".
 */
export async function streamAiChat(
  bookId: string,
  body: AiChatRequest,
  handlers: AiStreamHandlers,
  options?: { signal?: AbortSignal },
): Promise<void> {
  const response = await authorizedFetch(`/api/books/${bookId}/ai/chat`, {
    method: 'POST',
    body: JSON.stringify(body),
    signal: options?.signal,
  });

  if (!response.body) throw new SseProtocolError('AI 流意外结束');

  let finished = false;

  await readSseStream(response.body, (frame) => {
    switch (frame.event) {
      case 'meta':
        handlers.onMeta(parseFrame<AiStreamMeta>(frame.data));
        break;
      case 'delta': {
        const payload = parseFrame<{ text: string }>(frame.data);
        handlers.onDelta(payload.text);
        break;
      }
      case 'done':
        handlers.onDone(parseFrame<AiStreamDone>(frame.data));
        finished = true;
        break;
      case 'error':
        handlers.onError(parseFrame<AiStreamErrorPayload>(frame.data));
        finished = true;
        break;
      default:
        // Unknown event names are reserved for forward-compatible additions.
        break;
    }
  });

  if (!finished) throw new SseProtocolError('AI 流意外结束');
}
