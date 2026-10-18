import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, expect, it } from 'vitest';
import { FakeAiClient } from '../src/ai/fake';
import { OpenAiCompatibleClient } from '../src/ai/gateway';
import { AiUpstreamError, type AiStreamRequest } from '../src/ai/types';

const closers: Array<() => Promise<void>> = [];
afterEach(async () => {
  await Promise.all(closers.splice(0).map((close) => close()));
});

async function serveSse(
  handler: (response: import('node:http').ServerResponse) => void,
): Promise<{ baseUrl: string; requests: Array<{ headers: unknown; body: string }> }> {
  const requests: Array<{ headers: unknown; body: string }> = [];
  const server = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk) => {
      body += String(chunk);
    });
    request.on('end', () => {
      requests.push({ headers: request.headers, body });
      handler(response);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const port = (server.address() as AddressInfo).port;
  closers.push(
    () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  );
  return { baseUrl: `http://127.0.0.1:${port}`, requests };
}

function request(overrides: Partial<AiStreamRequest> = {}): AiStreamRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: '解释这段话' }],
    maxTokens: 128,
    temperature: 0.3,
    signal: new AbortController().signal,
    ...overrides,
  };
}

async function collect(
  client: { streamChat(r: AiStreamRequest): AsyncIterable<unknown> },
  input: AiStreamRequest,
) {
  const events: Array<{ type: string; text?: string; usage?: unknown }> = [];
  for await (const event of client.streamChat(input)) {
    events.push(event as { type: string; text?: string; usage?: unknown });
  }
  return events;
}

it('streams deltas and final usage from an OpenAI-compatible provider', async () => {
  const { baseUrl, requests } = await serveSse((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"第一"}}]}\n\n');
    response.write('data: {"choices":[{"delta":{"content":"段"}}]}\n\n');
    response.write('data: {"choices":[],"usage":{"prompt_tokens":12,"completion_tokens":3}}\n\n');
    response.end('data: [DONE]\n\n');
  });
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  const events = await collect(client, request());

  expect(
    events
      .filter((event) => event.type === 'delta')
      .map((event) => event.text)
      .join(''),
  ).toBe('第一段');
  expect(events.at(-1)).toEqual({
    type: 'usage',
    usage: { promptTokens: 12, completionTokens: 3 },
  });
  expect(requests[0]!.headers).toMatchObject({ authorization: 'Bearer sk-test-secret' });
  expect(requests[0]!.body).toContain('"stream":true');
});

it('maps provider failures to retryable upstream errors without leaking the body', async () => {
  const { baseUrl } = await serveSse((response) => {
    response.writeHead(429, { 'content-type': 'application/json' });
    response.end('{"error":{"message":"secret prompt text"}}');
  });
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  await expect(collect(client, request())).rejects.toMatchObject({
    name: 'AiUpstreamError',
    statusCode: 429,
    retryable: true,
  });
});

it('rejects malformed frames as non-retryable', async () => {
  const { baseUrl } = await serveSse((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.end('data: not-json\n\n');
  });
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  await expect(collect(client, request())).rejects.toBeInstanceOf(AiUpstreamError);
});

it('honours an external abort', async () => {
  const { baseUrl } = await serveSse((response) => {
    response.writeHead(200, { 'content-type': 'text/event-stream' });
    response.write('data: {"choices":[{"delta":{"content":"慢"}}]}\n\n');
  });
  const controller = new AbortController();
  const client = new OpenAiCompatibleClient(baseUrl, 'sk-test-secret');
  const iterator = client.streamChat(request({ signal: controller.signal }))[Symbol.asyncIterator]();
  await iterator.next();
  controller.abort();
  await expect(iterator.next()).rejects.toMatchObject({ name: 'AbortError' });
});

it('fakes deterministic chunks, usage and failures', async () => {
  const fake = new FakeAiClient({ chunkSize: 4, delayMs: 0 });
  const events = await collect(fake, request());
  expect(events.filter((event) => event.type === 'delta').length).toBeGreaterThan(1);
  expect(events.at(-1)!.type).toBe('usage');
  expect(fake.lastRequest?.messages.at(-1)!.content).toContain('解释这段话');

  const failing = new FakeAiClient({ chunkSize: 1, delayMs: 0, failAfter: 2 });
  await expect(collect(failing, request())).rejects.toMatchObject({ retryable: true });
});
