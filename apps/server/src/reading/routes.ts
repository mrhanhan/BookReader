import { updateProgressSchema } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { getProgress, saveProgress } from './progress';

const bookIdParamsSchema = z.object({ id: z.uuid() });

/** Registers the per-user reading endpoints. */
export function registerReadingRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.get('/api/books/:id/progress', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return { progress: await getProgress(deps, request.user!.id, id) };
  });

  app.put('/api/books/:id/progress', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    const { locator } = updateProgressSchema.parse(request.body);
    return { progress: await saveProgress(deps, request.user!, id, locator) };
  });
}
