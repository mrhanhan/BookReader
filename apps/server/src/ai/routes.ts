import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import {
  getAiUsage,
  getThreadDetail,
  listThreads,
  removeThread,
  setAiEnabled,
} from './service';

const bookParamsSchema = z.object({ id: z.uuid() });
const threadParamsSchema = z.object({ id: z.uuid() });
const aiToggleSchema = z.object({ enabled: z.boolean() });

/** Registers the caller-scoped AI thread, usage and preference endpoints. */
export function registerAiRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);
  const auth = { preHandler: requireAuth };

  app.get('/api/books/:id/ai/threads', auth, async (request) => {
    const { id } = bookParamsSchema.parse(request.params);
    return { items: await listThreads(deps, request.user!.id, id) };
  });

  app.get('/api/ai/threads/:id', auth, async (request) => {
    const { id } = threadParamsSchema.parse(request.params);
    return getThreadDetail(deps, request.user!.id, id);
  });

  app.delete('/api/ai/threads/:id', auth, async (request, reply) => {
    const { id } = threadParamsSchema.parse(request.params);
    await removeThread(deps, request.user!.id, id);
    return reply.status(204).send();
  });

  app.get('/api/ai/usage', auth, async (request) => {
    return getAiUsage(deps, request.user!.id);
  });

  app.patch('/api/me/ai', auth, async (request) => {
    const { enabled } = aiToggleSchema.parse(request.body);
    return { enabled: await setAiEnabled(deps, request.user!.id, enabled) };
  });
}
