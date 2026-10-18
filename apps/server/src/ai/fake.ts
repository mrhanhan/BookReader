import {
  AiUpstreamError,
  type AiClient,
  type AiStreamEvent,
  type AiStreamRequest,
} from './types';

export interface FakeAiOptions {
  reply?: string | ((request: AiStreamRequest) => string);
  chunkSize?: number;
  delayMs?: number;
  /** Number of deltas to emit before failing; omit for a full reply. */
  failAfter?: number;
}

const DEFAULT_REPLY = '【模拟 AI 回答】已收到上下文，这是本地假提供方返回的流式内容。';
const DEFAULT_CHUNK_SIZE = 8;
const DEFAULT_DELAY_MS = 5;

function wait(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

/**
 * Deterministic in-process provider used by `AI_FAKE_PROVIDER=1`. It mimics a
 * streaming upstream (chunks, usage, optional mid-stream failure) so the chat
 * route and its tests never need a real provider.
 */
export class FakeAiClient implements AiClient {
  readonly name = 'fake' as const;
  lastRequest: AiStreamRequest | null = null;
  private readonly options: FakeAiOptions;

  constructor(options: FakeAiOptions = {}) {
    this.options = options;
  }

  async *streamChat(request: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    this.lastRequest = request;

    const { reply, chunkSize, delayMs = DEFAULT_DELAY_MS, failAfter } = this.options;
    const text = typeof reply === 'function' ? reply(request) : (reply ?? DEFAULT_REPLY);
    const size =
      chunkSize !== undefined && Number.isFinite(chunkSize)
        ? Math.max(1, Math.trunc(chunkSize))
        : DEFAULT_CHUNK_SIZE;
    let emitted = 0;

    for (let offset = 0; offset < text.length; offset += size) {
      if (request.signal.aborted) {
        throw new DOMException('Aborted', 'AbortError');
      }
      if (failAfter !== undefined && emitted >= failAfter) {
        throw new AiUpstreamError('Fake AI failure', { retryable: true });
      }

      yield { type: 'delta', text: text.slice(offset, offset + size) };
      emitted += 1;

      if (delayMs > 0) {
        await wait(delayMs);
      }
    }

    const promptCharacters = request.messages.reduce(
      (total, message) => total + message.content.length,
      0,
    );
    yield {
      type: 'usage',
      usage: {
        promptTokens: Math.ceil(promptCharacters / 2),
        completionTokens: Math.ceil(text.length / 2),
      },
    };
  }
}
