/**
 * Reader SSE re-exports. The parser moved to `lib/sse.ts` so the notes API can
 * share it; `AiStreamProtocolError` stays as the P5 alias for the generic
 * `SseProtocolError` class.
 */
export {
  createSseParser,
  readSseStream,
  SseProtocolError,
  SseProtocolError as AiStreamProtocolError,
} from '../../../lib/sse';
export type { SseFrame } from '../../../lib/sse';
