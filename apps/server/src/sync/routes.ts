import {
  ERROR_CODES,
  syncPullQuerySchema,
  syncPushRequestSchema,
  type SyncChangeEnvelope,
} from '@bookr/shared';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { SYNC_STREAM_TOKEN_TTL_SECONDS, signSyncStreamToken, verifySyncStreamToken } from '../auth/tokens';
import { AppError } from '../errors';
import { applyPush, buildSnapshot, pullChanges } from './service';

/** Page size used while replaying a stream's backlog. */
const STREAM_PAGE_SIZE = 200;

/** Comment frame that keeps idle connections and proxies from timing out. */
const STREAM_PING_INTERVAL_MS = 25_000;

/** How long a client may stay unreadable before its stream is dropped. */
const STREAM_BACKPRESSURE_TIMEOUT_MS = 5_000;

const UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

const streamQuerySchema = z.object({
  token: z.string().min(1),
  since: syncPullQuerySchema.shape.since,
});

const SSE_HEADERS = {
  'content-type': 'text/event-stream',
  'cache-control': 'no-cache, no-transform',
  connection: 'keep-alive',
  'x-accel-buffering': 'no',
} as const;

function unauthorized(): AppError {
  return new AppError(401, ERROR_CODES.UNAUTHORIZED);
}

/** One change frame; the revision doubles as the SSE event id so clients can resume. */
function changeFrame(change: SyncChangeEnvelope): string {
  return `id: ${change.revision}\nevent: change\ndata: ${JSON.stringify(change)}\n\n`;
}

/**
 * Takes over the socket, subscribes first so nothing committed during the
 * backlog replay is lost, replays the backlog, then flushes and forwards live
 * changes until the client goes away. Cleanup is idempotent because a
 * disconnect, a write error and backpressure can race.
 */
async function openStream(
  deps: AppDeps,
  reply: FastifyReply,
  userId: string,
  since: number,
): Promise<void> {
  reply.hijack();
  const raw = reply.raw;
  raw.writeHead(200, SSE_HEADERS);
  // Without this, an empty backlog leaves the headers buffered and the client
  // waits for the first change before it even sees the stream open.
  raw.flushHeaders();

  let closed = false;
  let unsubscribe: (() => void) | undefined;
  let ping: NodeJS.Timeout | undefined;
  let backpressure: NodeJS.Timeout | undefined;

  const cleanup = (): void => {
    if (closed) {
      return;
    }
    closed = true;
    if (ping !== undefined) {
      clearInterval(ping);
    }
    if (backpressure !== undefined) {
      clearTimeout(backpressure);
    }
    unsubscribe?.();
    if (!raw.writableEnded) {
      raw.end();
    }
  };

  /** Clears the backpressure warning once the socket accepts writes again. */
  const onDrain = (): void => {
    if (backpressure !== undefined) {
      clearTimeout(backpressure);
      backpressure = undefined;
    }
  };

  const write = (chunk: string): boolean => {
    if (closed) {
      return false;
    }
    try {
      // A full buffer means the client stopped reading. Give it a grace period
      // to drain instead of growing an unbounded queue in memory.
      if (!raw.write(chunk) && backpressure === undefined) {
        backpressure = setTimeout(cleanup, STREAM_BACKPRESSURE_TIMEOUT_MS);
        backpressure.unref();
      }
      return true;
    } catch {
      cleanup();
      return false;
    }
  };

  // A client that disappears mid-replay must not leave a listener behind.
  reply.request.raw.on('close', cleanup);
  raw.on('error', cleanup);
  raw.on('drain', onDrain);

  // Subscribe before replaying. Changes committed while pages are being read
  // land in the buffer and are flushed below instead of falling into the gap
  // between the last page and the subscription.
  const buffered: SyncChangeEnvelope[] = [];
  let live = false;
  unsubscribe = deps.syncHub.subscribe(userId, (change) => {
    if (live) {
      write(changeFrame(change));
    } else {
      buffered.push(change);
    }
  });

  let cursor = since;
  for (;;) {
    if (closed) {
      return;
    }

    let page;
    try {
      page = await pullChanges(deps, userId, cursor, STREAM_PAGE_SIZE);
    } catch {
      cleanup();
      return;
    }

    if (closed) {
      return;
    }
    if (page.reset) {
      // The cursor predates the retained log; the client must resnapshot.
      write('event: reset\ndata: {}\n\n');
      break;
    }

    for (const change of page.changes) {
      if (!write(changeFrame(change))) {
        return;
      }
    }

    cursor = page.cursor;
    if (!page.hasMore) {
      break;
    }
  }

  // Publish order is monotonic per user, so anything the replay already
  // covered is at or below the cursor.
  for (const change of buffered) {
    if (change.revision > cursor) {
      if (!write(changeFrame(change))) {
        return;
      }
      cursor = change.revision;
    }
  }
  live = true;

  ping = setInterval(() => {
    write(': ping\n\n');
  }, STREAM_PING_INTERVAL_MS);
  ping.unref();
}

/** Registers the per-user sync endpoints. */
export function registerSyncRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.get('/api/sync/pull', { preHandler: requireAuth }, async (request) => {
    const { since, limit } = syncPullQuerySchema.parse(request.query);
    return pullChanges(deps, request.user!.id, since, limit);
  });

  app.get('/api/sync/snapshot', { preHandler: requireAuth }, async (request) => {
    return buildSnapshot(deps, request.user!.id);
  });

  app.post('/api/sync/push', { preHandler: requireAuth }, async (request) => {
    const { changes } = syncPushRequestSchema.parse(request.body);
    return applyPush(deps, request.user!, changes);
  });

  // EventSource cannot send headers, so the short-lived stream token rides in
  // the query string instead of the Authorization header.
  app.post('/api/sync/stream-token', { preHandler: requireAuth }, async (request) => {
    const { id, deviceId } = request.user!;
    const token = await signSyncStreamToken(
      { sub: id, ...(deviceId !== undefined ? { deviceId } : {}) },
      deps.config.jwtSecret,
    );
    return { token, expiresIn: SYNC_STREAM_TOKEN_TTL_SECONDS };
  });

  app.get('/api/sync/stream', async (request, reply) => {
    const parsed = streamQuerySchema.safeParse(request.query);
    if (!parsed.success) {
      const token = (request.query as { token?: unknown }).token;
      if (typeof token !== 'string' || token.length === 0) {
        throw unauthorized();
      }
      throw new AppError(400, ERROR_CODES.VALIDATION_FAILED);
    }

    let userId: string;
    try {
      const claims = await verifySyncStreamToken(parsed.data.token, deps.config.jwtSecret);
      if (!UUID_RE.test(claims.sub)) {
        throw new Error('Invalid subject');
      }
      userId = claims.sub;
    } catch {
      throw unauthorized();
    }

    await openStream(deps, reply, userId, parsed.data.since);
  });
}
