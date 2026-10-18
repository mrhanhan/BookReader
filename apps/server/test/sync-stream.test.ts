import { setTimeout as delay } from 'node:timers/promises';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import type { AppDeps } from '../src/app';
import { signSyncStreamToken } from '../src/auth/tokens';
import { listChanges } from '../src/sync/repo';
import { authHeader, createTestApp, resetDb, seedBook, seedUser, testDb } from './helpers';

async function startServer(): Promise<{ app: FastifyInstance; deps: AppDeps; url: string }> {
  const { app, deps } = await createTestApp();
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, deps, url };
}

/**
 * Closes the listener after dropping undici's idle keep-alive sockets; without
 * this `app.close()` waits out the client pool's four-second idle timeout.
 */
async function stopServer(app: FastifyInstance): Promise<void> {
  app.server.closeAllConnections();
  await app.close();
}

async function fetchStreamToken(
  app: FastifyInstance,
  headers: { authorization: string },
): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sync/stream-token',
    headers,
  });
  expect(response.statusCode).toBe(200);
  return response.json<{ token: string }>().token;
}

interface OpenStream {
  controller: AbortController;
  reader: ReadableStreamDefaultReader<Uint8Array>;
  text: string;
  /**
   * One read is kept in flight across timeout-driven waits. Starting a second
   * read while one is pending would consume the next event in the abandoned
   * read and make the following wait miss it.
   */
  pending: ReturnType<ReadableStreamDefaultReader<Uint8Array>['read']> | null;
}

async function openStream(url: string, token: string, since = 0): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/sync/stream?token=${encodeURIComponent(token)}&since=${since}`, {
    signal: controller.signal,
  });
  expect(response.status).toBe(200);
  expect(response.headers.get('content-type')).toContain('text/event-stream');
  return { controller, reader: response.body!.getReader(), text: '', pending: null };
}

const decoder = new TextDecoder();

type ChunkOutcome = 'data' | 'done' | 'timeout';

/** Appends the next chunk to `stream.text`, or reports a timeout. */
async function nextChunk(stream: OpenStream, timeoutMs: number): Promise<ChunkOutcome> {
  stream.pending ??= stream.reader.read();
  const result = await Promise.race([
    stream.pending,
    delay(timeoutMs).then(() => 'timeout' as const),
  ]);
  if (result === 'timeout') {
    return 'timeout';
  }

  stream.pending = null;
  if (result.done) {
    return 'done';
  }
  stream.text += decoder.decode(result.value, { stream: true });
  return 'data';
}

/** Reads until `predicate` holds over everything received so far. */
async function pumpUntil(
  stream: OpenStream,
  predicate: (text: string) => boolean,
  timeoutMs = 2_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate(stream.text)) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) {
      throw new Error(`Timed out waiting for stream data; received ${JSON.stringify(stream.text)}`);
    }
    const outcome = await nextChunk(stream, remaining);
    if (outcome === 'done') {
      throw new Error(`Stream ended early; received ${JSON.stringify(stream.text)}`);
    }
  }
  return stream.text;
}

/** Reads whatever arrives within `ms` without requiring any event. */
async function drainFor(stream: OpenStream, ms: number): Promise<string> {
  const deadline = Date.now() + ms;
  while (Date.now() < deadline) {
    const outcome = await nextChunk(stream, deadline - Date.now());
    if (outcome !== 'data') {
      break;
    }
  }
  return stream.text;
}

async function waitForSubscribers(
  deps: AppDeps,
  userId: string,
  expected: number,
  timeoutMs = 2_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (deps.syncHub.subscriberCount(userId) !== expected) {
    if (Date.now() >= deadline) {
      throw new Error(
        `Expected ${expected} subscribers for ${userId}, saw ${deps.syncHub.subscriberCount(userId)}`,
      );
    }
    await delay(10);
  }
}

async function pushProgress(
  url: string,
  headers: { authorization: string },
  bookId: string,
  page: number,
): Promise<void> {
  const response = await fetch(`${url}/api/books/${bookId}/progress`, {
    method: 'PUT',
    headers: { ...headers, 'content-type': 'application/json' },
    body: JSON.stringify({ locator: { kind: 'pdf', page, percent: page / 10 } }),
  });
  expect(response.status).toBe(200);
}

it('delivers a change to an open stream within two seconds', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const headers = await authHeader(user);
  const token = await fetchStreamToken(app, headers);

  const stream = await openStream(url, token, 0);
  // Subscribe happens after the backlog replay, so wait for it before pushing.
  await waitForSubscribers(deps, user.id, 1);

  const started = Date.now();
  await pushProgress(url, headers, book.id, 4);
  await pumpUntil(stream, (text) => text.includes('event: change'));
  expect(Date.now() - started).toBeLessThan(2_000);

  expect(stream.text).toContain('"entityType":"reading_progress"');
  expect(stream.text).toMatch(/(^|\n)id: \d+\nevent: change\n/);

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('replays the backlog from since', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id, format: 'pdf' });
  const headers = await authHeader(user);

  await pushProgress(url, headers, book.id, 3);
  await pushProgress(url, headers, book.id, 5);
  const backlog = await listChanges(testDb, user.id, 0, 10);
  expect(backlog.rows).toHaveLength(2);
  const firstRevision = backlog.rows[0]!.revision;
  const secondRevision = backlog.rows[1]!.revision;

  const token = await fetchStreamToken(app, headers);
  const stream = await openStream(url, token, firstRevision);
  await waitForSubscribers(deps, user.id, 1);
  await pumpUntil(stream, (text) => text.includes(`id: ${secondRevision}`));

  expect(stream.text).not.toContain(`id: ${firstRevision}`);
  expect(stream.text).toContain('"percent":0.5');

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('rejects a missing, forged or non-stream token', async () => {
  await resetDb();
  const { app, url } = await startServer();
  const user = await seedUser('member');
  const headers = await authHeader(user);

  const missing = await fetch(`${url}/api/sync/stream`);
  expect(missing.status).toBe(401);
  await missing.text();

  const garbage = await fetch(`${url}/api/sync/stream?token=not-a-jwt`);
  expect(garbage.status).toBe(401);
  await garbage.text();

  const forged = await signSyncStreamToken(
    { sub: user.id },
    'another-secret-value-that-is-long-enough',
  );
  const forgedResponse = await fetch(`${url}/api/sync/stream?token=${encodeURIComponent(forged)}`);
  expect(forgedResponse.status).toBe(401);
  await forgedResponse.text();

  // An access token shares issuer and audience but must not open a stream.
  const accessToken = headers.authorization.replace(/^Bearer\s+/i, '');
  const accessResponse = await fetch(
    `${url}/api/sync/stream?token=${encodeURIComponent(accessToken)}`,
  );
  expect(accessResponse.status).toBe(401);
  await accessResponse.text();

  await stopServer(app);
});

it('unsubscribes after the client disconnects', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  const headers = await authHeader(user);
  const token = await fetchStreamToken(app, headers);

  const stream = await openStream(url, token, 0);
  await waitForSubscribers(deps, user.id, 1);

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it("does not deliver another user's changes", async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const aliceBook = await seedBook({ uploadedBy: alice.id, format: 'pdf' });
  const bobBook = await seedBook({ uploadedBy: bob.id, format: 'pdf' });

  const aliceToken = await fetchStreamToken(app, await authHeader(alice));
  const stream = await openStream(url, aliceToken, 0);
  await waitForSubscribers(deps, alice.id, 1);

  await pushProgress(url, await authHeader(bob), bobBook.id, 7);
  await drainFor(stream, 500);

  expect(stream.text).not.toContain('event: change');
  expect(stream.text).not.toContain(bobBook.id);

  // Alice's own change still arrives on the same stream.
  await pushProgress(url, await authHeader(alice), aliceBook.id, 2);
  await pumpUntil(stream, (text) => text.includes('event: change'));
  expect(stream.text).toContain(aliceBook.id);

  stream.controller.abort();
  await waitForSubscribers(deps, alice.id, 0);
  await stopServer(app);
});

it('rejects a stream-token request without a login', async () => {
  await resetDb();
  const { app } = await startServer();

  const response = await app.inject({ method: 'POST', url: '/api/sync/stream-token' });
  expect(response.statusCode).toBe(401);

  await stopServer(app);
});

it('issues a stream token that carries the caller identity', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  const headers = await authHeader(user);

  const response = await app.inject({
    method: 'POST',
    url: '/api/sync/stream-token',
    headers,
  });
  expect(response.statusCode).toBe(200);
  expect(response.json().expiresIn).toBe(60);
  expect(typeof response.json().token).toBe('string');

  // The issued token is accepted by the stream endpoint for the same user.
  const stream = await openStream(url, response.json().token, 0);
  await waitForSubscribers(deps, user.id, 1);
  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});
