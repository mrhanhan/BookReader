import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAdmin, makeRequireAuth } from '../auth/guards';
import { auditLogs, aiConfig } from '../db/schema';
import { AI_CONFIG_ID, readAiConfigView, writeAiConfig } from './config';

const updateAiConfigSchema = z
  .object({
    baseUrl: z.string().min(1).max(512).optional(),
    chatModel: z.string().min(1).max(64).optional(),
    reasonerModel: z.string().min(1).max(64).optional(),
    apiKey: z.string().min(8).max(256).optional(),
  })
  .refine((body) => Object.keys(body).length > 0, {
    message: 'at least one field is required',
  });

/** Registers the administrator-only AI provider endpoints. */
export function registerAiAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);
  const requireAdmin = makeRequireAdmin();
  const adminOnly = { preHandler: [requireAuth, requireAdmin] };

  app.get('/api/admin/ai', adminOnly, async () => {
    return readAiConfigView(deps);
  });

  app.put('/api/admin/ai', adminOnly, async (request) => {
    const body = updateAiConfigSchema.parse(request.body);
    return writeAiConfig(deps, request.user!.id, body);
  });

  app.delete('/api/admin/ai', adminOnly, async (request, reply) => {
    await deps.db.transaction(async (tx) => {
      await tx.delete(aiConfig).where(eq(aiConfig.id, AI_CONFIG_ID));
      await tx.insert(auditLogs).values({
        userId: request.user!.id,
        action: 'ai.config.delete',
        target: AI_CONFIG_ID,
      });
    });
    return reply.status(204).send();
  });
}
