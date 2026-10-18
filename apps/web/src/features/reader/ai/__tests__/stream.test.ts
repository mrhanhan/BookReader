import { expect, it } from 'vitest';
import {
  AiStreamProtocolError,
  createSseParser,
  readSseStream,
  type SseFrame,
} from '../stream';

function streamOf(chunks: string[]): ReadableStream<Uint8Array> {
  const encoder = new TextEncoder();
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(encoder.encode(chunk));
      controller.close();
    },
  });
}

it('parses frames across chunk boundaries, CRLF and multi-line data', () => {
  const frames: SseFrame[] = [];
  const parser = createSseParser((frame) => frames.push(frame));
  parser.push('event: meta\r\ndata: {"a":1}\r\n\r\n:: comment\r\nevent: delta\ndata: line1\ndata: line2\n');
  parser.push('\n');
  parser.flush();
  expect(frames).toEqual([
    { event: 'meta', data: '{"a":1}' },
    { event: 'delta', data: 'line1\nline2' },
  ]);
});

it('throws on an incomplete trailing frame', () => {
  const parser = createSseParser(() => undefined);
  parser.push('event: delta\ndata: {"text":"x"}\n');
  expect(() => parser.flush()).toThrow(AiStreamProtocolError);
});

it('reads a byte stream incrementally and dispatches its frames', async () => {
  const frames: SseFrame[] = [];
  await readSseStream(streamOf(['event: delta\ndata: {"text":"你', '好"}\n\n']), (frame) => frames.push(frame));
  expect(frames).toEqual([{ event: 'delta', data: '{"text":"你好"}' }]);
});
