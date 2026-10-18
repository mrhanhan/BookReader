import type { AiRuntimeConfig } from './config';

/** One message sent to the provider; the transcript uses user/assistant roles. */
export interface AiChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

/** Token accounting reported by a provider for one completion. */
export interface AiTokenUsage {
  promptTokens: number;
  completionTokens: number;
}

/** A streaming completion request handed to an `AiClient`. */
export interface AiStreamRequest {
  model: string;
  messages: AiChatMessage[];
  maxTokens: number;
  temperature: number;
  signal: AbortSignal;
}

/** Incremental output of a streaming completion. */
export type AiStreamEvent =
  | { type: 'delta'; text: string }
  | { type: 'usage'; usage: AiTokenUsage };

/** A provider client built for one request from the current AI configuration. */
export interface AiClient {
  readonly name: string;
  streamChat(request: AiStreamRequest): AsyncIterable<AiStreamEvent>;
}

/** A provider failure mapped to retryable/timeout handling by the chat route. */
export class AiUpstreamError extends Error {
  readonly statusCode?: number;
  readonly retryable: boolean;

  constructor(message: string, options: { statusCode?: number; retryable?: boolean } = {}) {
    super(message);
    this.name = 'AiUpstreamError';
    this.statusCode = options.statusCode;
    this.retryable = options.retryable ?? false;
  }
}

/**
 * Placeholder client used until the runtime factory is wired. Every request
 * fails as unretryable so callers report "not configured" rather than
 * retrying a provider that does not exist.
 */
export function createUnavailableAiClient(): AiClient {
  return {
    name: 'unavailable',
    async *streamChat(): AsyncIterable<AiStreamEvent> {
      throw new AiUpstreamError('AI client is not configured', { retryable: false });
    },
  };
}

/** Builds the placeholder `AppDeps.aiClientFactory` used before Task 8. */
export function createUnavailableAiClientFactory(): (config: AiRuntimeConfig) => AiClient {
  return () => createUnavailableAiClient();
}
