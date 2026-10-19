import type { ServerResponse } from 'node:http';

/** Streaming responses must not be buffered by proxies or browsers. */
export const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

function abortError(): DOMException {
  return new DOMException('Aborted', 'AbortError');
}

/** Writes one SSE frame, waiting for drain when the socket applies backpressure. */
export async function writeSseFrame(
  raw: ServerResponse,
  event: string,
  data: unknown,
  onBackpressure?: () => void,
): Promise<void> {
  if (raw.writableEnded || raw.destroyed) {
    throw abortError();
  }
  const frame = `event: ${event}
data: ${JSON.stringify(data)}

`;
  if (raw.write(frame)) return;

  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      cleanup();
      onBackpressure?.();
      reject(new Error('AI stream backpressure timed out'));
    }, 5_000);
    const cleanup = (): void => {
      clearTimeout(timer);
      raw.removeListener('drain', onDrain);
    };
    const onDrain = (): void => {
      cleanup();
      resolve();
    };
    raw.once('drain', onDrain);
  });
}
