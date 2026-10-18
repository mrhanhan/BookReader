import {
  ERROR_CODES,
  syncPullQuerySchema,
  syncPushRequestSchema,
  type SyncChangeEnvelope,
} from '@bookr/shared';
import { and, eq, isNull } from 'drizzle-orm';
import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { SYNC_STREAM_TOKEN_TTL_SECONDS, signSyncStreamToken, verifySyncStreamToken } from '../auth/tokens';
import { devices, users } from '../db/schema';
import { AppError } from '../errors';
import { applyPush, buildSnapshot, pullChanges } from './service';

/** Page size used while replaying a stream's backlog. */
const STREAM_PAGE_SIZE = 200;

/** Comment frame that keeps idle connections and proxies from timing out. */
const STREAM_PING_INTERVAL_MS = 25_000;

/** How long a client may stay unreadable before its stream is dropped. */
const STREAM_BACKPRESSURE_TIMEOUT_MS = 5_000;

/**
 * A full push may carry 100 annotations of 10 KB selected text and 10 KB note
 * text each, which is roughly 2 MiB. Fastify's 1 MiB default would reject a
 * legitimate batch with 413, so the route gets its own ceiling.
 */
const SYNC_PUSH_BODY_LIMIT_BYTES = 4 * 1024 * 1024;

/** Tuning knobs the app passes down; tests shorten the stream period. */
export interface SyncRouteOptions {
  pingIntervalMs?: number;
}

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

/**
 * Cheap authorization re-check for a stream: the account must still be active
 * and, when the token is device-bound, that device must not have been revoked.
 * Run at stream open and again on every ping so account disabling and device
 * revocation close an already-open stream instead of waiting for its token.
 */
async function isStreamAuthorized(
  deps: AppDeps,
  userId: string,
  deviceId: string | undefined,
): Promise<boolean> {
  const [user] = await deps.db
    .select({ isActive: users.isActive })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  if (!user || !user.isActive) {
    return false;
  }
  if (deviceId === undefined) {
    // Legacy tokens predate device binding; there is no device to check.
    return true;
  }
  if (!UUID_RE.test(deviceId)) {
    return false;
  }
  const [device] = await deps.db
    .select({ id: devices.id })
    .from(devices)
    .where(
      and(
        eq(devices.id, deviceId),
        eq(devices.userId, userId),
        isNull(devices.revokedAt),
      ),
    )
    .limit(1);
  return device !== undefined;
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
  deviceId: string | undefined,
  since: number,
  activeStreams: Set<() => void>,
  isClosing: () => boolean,
  pingIntervalMs: number,
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
    activeStreams.delete(cleanup);
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
  activeStreams.add(cleanup);

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

  // preClose may have run while this request was still verifying its token.
  // End the stream and drop the listener that was just registered; cleanup
  // alone cannot do it if a disconnect already fired before subscribe.
  if (closed || isClosing()) {
    cleanup();
    unsubscribe();
    return;
  }

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

  let revalidating = false;
  ping = setInterval(() => {
    if (revalidating) {
      return;
    }
    revalidating = true;
    void isStreamAuthorized(deps, userId, deviceId)
      .then((authorized) => {
        if (!authorized) {
          cleanup();
          return;
        }
        write(': ping\n\n');
      })
      .catch(() => {
        // A failed check must not keep a stream that may already be invalid.
        cleanup();
      })
      .finally(() => {
        revalidating = false;
      });
  }, pingIntervalMs);
  ping.unref();
}

/** Registers the per-user sync endpoints. */
export function registerSyncRoutes(
  app: FastifyInstance,
  deps: AppDeps,
  options: SyncRouteOptions = {},
): void {
  const pingIntervalMs = options.pingIntervalMs ?? STREAM_PING_INTERVAL_MS;
  const requireAuth = makeRequireAuth(deps);
  // Open SSE responses keep the server from closing; preClose ends them first
  // and waits for their handlers so no transaction outlives the app. Ordinary
  // in-flight requests then finish under the default close policy.
  const activeStreams = new Set<() => void>();
  const runningStreams = new Set<Promise<void>>();
  let closing = false;
  app.addHook('preClose', async () => {
    closing = true;
    for (const cleanup of [...activeStreams]) {
      cleanup();
    }
    await Promise.allSettled([...runningStreams]);
  });

  app.get('/api/sync/pull', { preHandler: requireAuth }, async (request) => {
    const { since, limit } = syncPullQuerySchema.parse(request.query);
    return pullChanges(deps, request.user!.id, since, limit);
  });

  app.get('/api/sync/snapshot', { preHandler: requireAuth }, async (request) => {
    return buildSnapshot(deps, request.user!.id);
  });

  app.post(
    '/api/sync/push',
    { preHandler: requireAuth, bodyLimit: SYNC_PUSH_BODY_LIMIT_BYTES },
    async (request) => {
      const { changes } = syncPushRequestSchema.parse(request.body);
      return applyPush(deps, request.user!, changes);
    },
  );

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
    let deviceId: string | undefined;
    try {
      const claims = await verifySyncStreamToken(parsed.data.token, deps.config.jwtSecret);
      if (!UUID_RE.test(claims.sub)) {
        throw new Error('Invalid subject');
      }
      userId = claims.sub;
      deviceId = claims.deviceId;
    } catch {
      throw unauthorized();
    }

    // The token may have been minted before the device was revoked or the
    // account disabled, so verify the current state before hijacking.
    if (!(await isStreamAuthorized(deps, userId, deviceId))) {
      throw unauthorized();
    }

    const stream = openStream(
      deps,
      reply,
      userId,
      deviceId,
      parsed.data.since,
      activeStreams,
      () => closing,
      pingIntervalMs,
    );
    runningStreams.add(stream);
    try {
      await stream;
    } finally {
      runningStreams.delete(stream);
    }
  });
}
