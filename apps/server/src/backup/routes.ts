import { backupHeartbeatSchema } from '@bookr/shared';
import { createHash, timingSafeEqual } from 'node:crypto';
import type { FastifyInstance, preHandlerAsyncHookHandler } from 'fastify';
import type { AppDeps } from '../app';
import { makeRequireAdmin, makeRequireAuth } from '../auth/guards';
import { getBackupStatus, recordBackupReport } from './service';

/**
 * Compares the presented token with the configured one in constant time.
 * Both values are hashed first so the comparison length never depends on the
 * input. A missing configuration disables the channel entirely.
 */
function hasValidBackupToken(deps: AppDeps, header: string | string[] | undefined): boolean {
  const configured = deps.config.backup.token;
  if (configured === null || typeof header !== 'string') {
    return false;
  }
  const expected = createHash('sha256').update(configured, 'utf8').digest();
  const provided = createHash('sha256').update(header, 'utf8').digest();
  return timingSafeEqual(expected, provided);
}

/** Registers the backup heartbeat and status endpoints. */
export function registerBackupRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps) as unknown as preHandlerAsyncHookHandler;
  const requireAdmin = makeRequireAdmin() as unknown as preHandlerAsyncHookHandler;

  /**
   * The unique auth exception: a shared token (used by unattended backup
   * hosts) or a regular admin JWT. Failures are indistinguishable from a
   * plain auth failure, so the response never reveals whether a token exists.
   */
  const heartbeatAuth: preHandlerAsyncHookHandler = async (request, reply) => {
    if (hasValidBackupToken(deps, request.headers['x-backup-token'])) {
      return;
    }
    await requireAuth.call(app, request, reply);
    await requireAdmin.call(app, request, reply);
  };

  app.post(
    '/api/admin/backup/heartbeat',
    { preHandler: [heartbeatAuth] },
    async (request, reply) => {
      const input = backupHeartbeatSchema.parse(request.body);
      const report = await recordBackupReport(deps, input);
      return reply.status(201).send({ id: report.id, receivedAt: report.receivedAt });
    },
  );

  app.get(
    '/api/admin/backup',
    { preHandler: [requireAuth, requireAdmin] },
    async () => getBackupStatus(deps),
  );
}
