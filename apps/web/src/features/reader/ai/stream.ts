/** One `event`/`data` pair parsed from a server-sent event stream. */
export interface SseFrame {
  event: string;
  data: string;
}

/** Raised when the AI stream ends or formats a frame in an unusable way. */
export class AiStreamProtocolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'AiStreamProtocolError';
  }
}

function incompleteFrame(): AiStreamProtocolError {
  return new AiStreamProtocolError('AI 流意外结束');
}

/**
 * Incremental server-sent events parser. Chunks may split lines, CRLF pairs and
 * multi-byte characters; only complete lines are consumed until the next
 * chunk arrives.
 */
export function createSseParser(onFrame: (frame: SseFrame) => void): {
  push(chunk: string): void;
  flush(): void;
} {
  let buffer = '';
  let eventName: string | null = null;
  let dataLines: string[] = [];

  function dispatch(): void {
    const hasData = dataLines.length > 0;
    const frame: SseFrame = {
      event: eventName || 'message',
      data: dataLines.join('\n'),
    };
    eventName = null;
    dataLines = [];
    // A frame without a data line carries nothing the AI protocol can use.
    if (hasData) onFrame(frame);
  }

  function handleLine(line: string): void {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;

    const colon = line.indexOf(':');
    const field = colon === -1 ? line : line.slice(0, colon);
    let value = colon === -1 ? '' : line.slice(colon + 1);
    if (value.startsWith(' ')) value = value.slice(1);

    if (field === 'event') {
      eventName = value;
    } else if (field === 'data') {
      dataLines.push(value);
    }
    // Other fields (id, retry) are irrelevant to the AI protocol.
  }

  return {
    push(chunk: string): void {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        let line = buffer.slice(0, newline);
        if (line.endsWith('\r')) line = line.slice(0, -1);
        buffer = buffer.slice(newline + 1);
        handleLine(line);
        newline = buffer.indexOf('\n');
      }
    },

    flush(): void {
      if (buffer !== '' || eventName !== null || dataLines.length > 0) {
        throw incompleteFrame();
      }
    },
  };
}

/** Reads an SSE byte stream to completion, dispatching each parsed frame. */
export async function readSseStream(
  stream: ReadableStream<Uint8Array>,
  onFrame: (frame: SseFrame) => void,
): Promise<void> {
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  const parser = createSseParser(onFrame);

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (value) parser.push(decoder.decode(value, { stream: true }));
    }
    parser.push(decoder.decode());
    parser.flush();
  } catch (error) {
    // Stop pulling bytes once a parser or handler failure abandons the stream.
    void reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
}
