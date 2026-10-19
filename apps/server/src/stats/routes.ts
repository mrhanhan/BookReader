import type { FastifyInstance } from 'fastify';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { getReadingStats } from './service';

/** Registers the caller's read-only reading statistics endpoint. */
export function registerStatsRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.get('/api/stats', { preHandler: requireAuth }, async (request) => {
    return getReadingStats(deps, request.user!.id);
  });
}
