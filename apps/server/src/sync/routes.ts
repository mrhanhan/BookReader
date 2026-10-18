import { syncPullQuerySchema } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { buildSnapshot, pullChanges } from './service';

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
}
