import { connect } from 'node:net';
import { Writable } from 'node:stream';
import { setTimeout as delay } from 'node:timers/promises';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { expect, it } from 'vitest';
import { redactRequestUrl, type AppDeps, type BuildAppOptions } from '../src/app';
import { signSyncStreamToken } from '../src/auth/tokens';
import { devices, syncChanges } from '../src/db/schema';
import { listChanges, markPrunedThrough } from '../src/sync/repo';
import {
  authHeader,
  buildTestConfig,
  createTestApp,
  resetDb,
  seedBook,
  seedUser,
  setUserInactive,
  testDb,
} from './helpers';

async function startServer(
  options: BuildAppOptions = {},
): Promise<{ app: FastifyInstance; deps: AppDeps; url: string }> {
  const { app, deps } = await createTestApp({}, options);
  const url = await app.listen({ port: 0, host: '127.0.0.1' });
  return { app, deps, url };
}

/**
 * Closes the listener after dropping undici's pooled sockets; the test client
 * would otherwise keep `app.close()` waiting out its keep-alive timeout.
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

async function openStream(
  url: string,
  token: string,
  since = 0,
  headers: Record<string, string> = {},
): Promise<OpenStream> {
  const controller = new AbortController();
  const response = await fetch(`${url}/api/sync/stream?token=${encodeURIComponent(token)}&since=${since}`, {
    signal: controller.signal,
    headers,
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

/** Reads until the server ends the stream, failing if it stays open. */
async function waitForEnd(stream: OpenStream, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const outcome = await nextChunk(stream, deadline - Date.now());
    if (outcome === 'done') {
      return;
    }
    if (outcome === 'timeout') {
      break;
    }
  }
  throw new Error(`Stream did not close; received ${JSON.stringify(stream.text)}`);
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

/** Inserts log rows directly so tests can build backlogs of any size cheaply. */
async function insertBacklog(userId: string, count: number): Promise<number[]> {
  const rows = Array.from({ length: count }, (_, index) => ({
    userId,
    entityType: 'bookmark' as const,
    entityId: `backlog-${index}`,
    op: 'upsert' as const,
    payload: { index },
    clientUpdatedAt: new Date(),
    serverUpdatedAt: new Date(),
  }));
  const inserted = await testDb
    .insert(syncChanges)
    .values(rows)
    .returning({ revision: syncChanges.revision });
  return inserted.map((row) => row.revision);
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
  // The subscription is registered before the backlog replay, so a push now
  // cannot fall into a gap; wait until it exists to keep the assertion stable.
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

it('refuses a stream token whose device was revoked or user was disabled', async () => {
  await resetDb();
  const { app, url } = await startServer();
  const revoked = await seedUser('member', 'revoked-device');
  const disabled = await seedUser('member', 'disabled-account');

  // Mint the tokens first: they stay cryptographically valid for 60 seconds.
  const revokedToken = await fetchStreamToken(app, await authHeader(revoked));
  const disabledToken = await fetchStreamToken(app, await authHeader(disabled));

  await testDb
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(eq(devices.id, revoked.deviceId));
  await setUserInactive(app, disabled.username);

  for (const token of [revokedToken, disabledToken]) {
    const response = await fetch(
      `${url}/api/sync/stream?token=${encodeURIComponent(token)}&since=0`,
    );
    expect(response.status).toBe(401);
    await response.text();
  }

  await stopServer(app);
});

it('closes an open stream when its device is revoked', async () => {
  await resetDb();
  const { app, deps, url } = await startServer({ streamPingIntervalMs: 100 });
  const user = await seedUser('member');
  const token = await fetchStreamToken(app, await authHeader(user));

  const stream = await openStream(url, token, 0);
  await waitForSubscribers(deps, user.id, 1);

  await testDb
    .update(devices)
    .set({ revokedAt: new Date() })
    .where(eq(devices.id, user.deviceId));

  // The revalidation runs on the ping timer; two cycles is 200 ms here.
  await waitForEnd(stream, 2_000);
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('closes an open stream when its user is disabled', async () => {
  await resetDb();
  const { app, deps, url } = await startServer({ streamPingIntervalMs: 100 });
  const user = await seedUser('member');
  const token = await fetchStreamToken(app, await authHeader(user));

  const stream = await openStream(url, token, 0);
  await waitForSubscribers(deps, user.id, 1);

  await setUserInactive(app, user.username);

  await waitForEnd(stream, 2_000);
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

/** Captures JSON log lines so tests can inspect what the server logs. */
function logSink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  const stream = new Writable({
    write(chunk, _encoding, callback) {
      chunks.push(String(chunk));
      callback();
    },
  });
  return { stream, text: () => chunks.join('') };
}

it('redacts the stream token from request logs', async () => {
  await resetDb();
  const sink = logSink();
  const { app, deps, url } = await startServer({ logStream: sink.stream });
  const user = await seedUser('member');
  const token = await fetchStreamToken(app, await authHeader(user));

  const stream = await openStream(url, token, 0, { 'accept-version': '1.1' });
  await waitForSubscribers(deps, user.id, 1);

  const logs = sink.text();
  expect(logs).toContain('"url":"/api/sync/stream?since=0"');
  expect(logs).not.toContain(token);
  expect(logs).not.toContain('token=');
  // The default request fields survive the custom serializer.
  expect(logs).toContain('"version":"1.1"');
  expect(logs).toContain('"host"');
  expect(logs).toContain('"remotePort"');

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('redacts a percent-encoded token parameter name', async () => {
  await resetDb();
  const sink = logSink();
  const { app, deps, url } = await startServer({ logStream: sink.stream });
  const user = await seedUser('member');
  const token = await fetchStreamToken(app, await authHeader(user));

  const controller = new AbortController();
  const response = await fetch(
    `${url}/api/sync/stream?%74oken=${encodeURIComponent(token)}&since=0`,
    { signal: controller.signal },
  );
  expect(response.status).toBe(200);
  await waitForSubscribers(deps, user.id, 1);

  const logs = sink.text();
  expect(logs).not.toContain(token);
  expect(logs).not.toContain('%74oken');

  controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('redacts every duplicate token parameter', async () => {
  await resetDb();
  const sink = logSink();
  const { app, url } = await startServer({ logStream: sink.stream });
  await seedUser('member');

  const response = await fetch(
    `${url}/api/sync/stream?token=first-secret-value&token=second-secret-value`,
  );
  expect(response.status).toBe(401);
  await response.text();

  const logs = sink.text();
  expect(logs).not.toContain('first-secret-value');
  expect(logs).not.toContain('second-secret-value');

  await stopServer(app);
});

it('closes the server promptly while a stream is open', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  const token = await fetchStreamToken(app, await authHeader(user));

  const stream = await openStream(url, token, 0);
  await waitForSubscribers(deps, user.id, 1);

  const started = Date.now();
  await app.close();
  expect(Date.now() - started).toBeLessThan(2_000);
  // preClose must also drop the hub listener, not just end the socket.
  expect(deps.syncHub.subscriberCount(user.id)).toBe(0);

  stream.controller.abort();
});

it('drops a subscription that registers while the server is closing', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  const token = await fetchStreamToken(app, await authHeader(user));
  const controller = new AbortController();

  // Do not await the response: the route may still be between hijacking the
  // socket and registering its listener when preClose runs. Whatever happens,
  // no listener may survive the close.
  const pending = fetch(
    `${url}/api/sync/stream?token=${encodeURIComponent(token)}&since=0`,
    { signal: controller.signal },
  ).catch(() => null);

  await app.close();
  expect(deps.syncHub.subscriberCount(user.id)).toBe(0);

  controller.abort();
  await pending;
});

it('does not lose changes committed while the backlog is replaying', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  // More than one page of backlog keeps the route busy while the change lands.
  await insertBacklog(user.id, 450);

  const token = await fetchStreamToken(app, await authHeader(user));
  const stream = await openStream(url, token, 0);

  const synthetic = {
    revision: 9_000_000,
    entityType: 'bookmark' as const,
    entityId: 'during-replay',
    op: 'upsert' as const,
    payload: { during: true },
    clientUpdatedAt: new Date().toISOString(),
    serverUpdatedAt: new Date().toISOString(),
  };
  deps.syncHub.publish(user.id, synthetic);

  await pumpUntil(stream, (text) => text.includes('during-replay'), 5_000);
  expect(stream.text.split('during-replay').length - 1).toBe(1);

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('rejects an expired stream token', async () => {
  await resetDb();
  const { app, url } = await startServer();
  const user = await seedUser('member');
  const expired = await signSyncStreamToken(
    { sub: user.id },
    buildTestConfig().jwtSecret,
    -1,
  );

  const response = await fetch(`${url}/api/sync/stream?token=${encodeURIComponent(expired)}`);
  expect(response.status).toBe(401);
  await response.text();

  await stopServer(app);
});

it('sends a reset event when the cursor predates the watermark', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  await insertBacklog(user.id, 3);
  await testDb.transaction((tx) => markPrunedThrough(tx, 2));

  const token = await fetchStreamToken(app, await authHeader(user));
  const stream = await openStream(url, token, 1);

  await pumpUntil(stream, (text) => text.includes('event: reset'), 3_000);
  expect(stream.text).toContain('event: reset');

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('replays more than one page of backlog', async () => {
  await resetDb();
  const { app, deps, url } = await startServer();
  const user = await seedUser('member');
  await insertBacklog(user.id, 450);

  const token = await fetchStreamToken(app, await authHeader(user));
  const stream = await openStream(url, token, 0);

  await pumpUntil(stream, (text) => text.includes('backlog-449'), 5_000);
  expect(stream.text).toContain('backlog-0');
  expect(stream.text.match(/event: change/g) ?? []).toHaveLength(450);

  stream.controller.abort();
  await waitForSubscribers(deps, user.id, 0);
  await stopServer(app);
});

it('survives a malformed request target without leaking it', async () => {
  await resetDb();
  const sink = logSink();
  const { app, url } = await startServer({ logStream: sink.stream });

  // Node's HTTP parser accepts this target, but `new URL` rejects it.
  expect(redactRequestUrl('//[bad/x?token=secret-value')).toBe('[unparseable-url]');

  const port = Number(new URL(url).port);
  await new Promise<void>((resolve, reject) => {
    const socket = connect(port, '127.0.0.1', () => {
      socket.write(
        'GET //[bad/x?token=SECRET-TARGET HTTP/1.1\r\nHost: localhost\r\nConnection: close\r\n\r\n',
      );
    });
    socket.on('data', () => undefined);
    socket.on('end', () => resolve());
    socket.on('error', reject);
  });
  // Let pino flush the request line before reading the sink.
  await delay(50);

  const logs = sink.text();
  expect(logs).toContain('[unparseable-url]');
  expect(logs).not.toContain('SECRET-TARGET');
  expect(logs).not.toContain('//[bad');

  // The process and its server are still healthy.
  const health = await fetch(`${url}/healthz`);
  expect(health.status).toBe(200);
  await health.text();

  await stopServer(app);
});
