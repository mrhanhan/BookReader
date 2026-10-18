import {
  AiUpstreamError,
  type AiClient,
  type AiStreamEvent,
  type AiStreamRequest,
  type AiTokenUsage,
} from './types';

export interface OpenAiCompatibleOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 60_000;

/** The subset of an OpenAI streaming frame this gateway reads. */
interface StreamFrame {
  choices?: Array<{ delta?: { content?: unknown } }>;
  usage?: { prompt_tokens?: unknown; completion_tokens?: unknown } | null;
}

function toTokenCount(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

/**
 * Parses one SSE line into zero or more events. A single frame may carry both
 * a delta and usage, so the result is a list; `'done'` ends the stream.
 */
function parseLine(rawLine: string): AiStreamEvent[] | 'done' | null {
  const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
  if (!line.startsWith('data:')) {
    return null;
  }

  const payload = line.slice('data:'.length).trim();
  if (payload === '') {
    return null;
  }
  if (payload === '[DONE]') {
    return 'done';
  }

  let frame: unknown;
  try {
    frame = JSON.parse(payload);
  } catch {
    throw new AiUpstreamError('Malformed AI stream', { retryable: false });
  }
  if (typeof frame !== 'object' || frame === null) {
    return null;
  }

  const record = frame as StreamFrame;
  const events: AiStreamEvent[] = [];

  const content = record.choices?.[0]?.delta?.content;
  if (typeof content === 'string' && content.length > 0) {
    events.push({ type: 'delta', text: content });
  }

  if (record.usage !== undefined && record.usage !== null) {
    const usage: AiTokenUsage = {
      promptTokens: toTokenCount(record.usage.prompt_tokens),
      completionTokens: toTokenCount(record.usage.completion_tokens),
    };
    events.push({ type: 'usage', usage });
  }

  return events.length > 0 ? events : null;
}

/**
 * Maps transport failures to the gateway contract: an external abort surfaces
 * as `AbortError`, our own timeout as a retryable upstream timeout, and
 * everything else as a generic retryable failure.
 */
function toTransportError(
  request: AiStreamRequest,
  timeoutSignal: AbortSignal,
): Error {
  if (request.signal.aborted) {
    return new DOMException('Aborted', 'AbortError');
  }
  if (timeoutSignal.aborted) {
    return new AiUpstreamError('AI request timed out', { retryable: true });
  }
  return new AiUpstreamError('AI request failed', { retryable: true });
}

/**
 * Streaming client for OpenAI-compatible providers. One instance is built per
 * conversation from the current configuration, so the key never outlives the
 * request that needed it.
 */
export class OpenAiCompatibleClient implements AiClient {
  readonly name = 'openai-compatible' as const;
  private readonly endpoint: string;
  private readonly apiKey: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(baseUrl: string, apiKey: string, options: OpenAiCompatibleOptions = {}) {
    this.endpoint = `${baseUrl.replace(/\/+$/u, '')}/chat/completions`;
    this.apiKey = apiKey;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  async *streamChat(request: AiStreamRequest): AsyncIterable<AiStreamEvent> {
    const timeoutSignal = AbortSignal.timeout(this.timeoutMs);
    const signal = AbortSignal.any([request.signal, timeoutSignal]);

    let response: Response;
    try {
      response = await this.fetchImpl(this.endpoint, {
        method: 'POST',
        headers: {
          authorization: `Bearer ${this.apiKey}`,
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: request.model,
          messages: request.messages,
          stream: true,
          stream_options: { include_usage: true },
          max_tokens: request.maxTokens,
          temperature: request.temperature,
        }),
        signal,
      });
    } catch {
      throw toTransportError(request, timeoutSignal);
    }

    if (!response.ok) {
      // Drain nothing: the provider body may echo prompt text and must not
      // reach logs or error messages.
      await response.body?.cancel().catch(() => undefined);
      throw new AiUpstreamError(`AI provider returned HTTP ${response.status}`, {
        statusCode: response.status,
        retryable: response.status === 429 || response.status >= 500,
      });
    }

    if (response.body === null) {
      throw new AiUpstreamError('AI request failed', { retryable: true });
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    try {
      for (;;) {
        let chunk: Awaited<ReturnType<typeof reader.read>>;
        try {
          chunk = await reader.read();
        } catch {
          throw toTransportError(request, timeoutSignal);
        }

        if (chunk.done) {
          break;
        }

        buffer += decoder.decode(chunk.value, { stream: true });

        let newline = buffer.indexOf('\n');
        while (newline !== -1) {
          const line = buffer.slice(0, newline);
          buffer = buffer.slice(newline + 1);
          const parsed = parseLine(line);
          if (parsed === 'done') {
            return;
          }
          if (parsed !== null) {
            yield* parsed;
          }
          newline = buffer.indexOf('\n');
        }
      }

      buffer += decoder.decode();
      if (buffer.length > 0) {
        const parsed = parseLine(buffer);
        if (parsed !== null && parsed !== 'done') {
          yield* parsed;
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined);
    }
  }
}
