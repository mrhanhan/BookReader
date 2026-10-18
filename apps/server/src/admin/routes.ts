import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAdmin, makeRequireAuth } from '../auth/guards';
import {
  MAX_INVITE_HOURS,
  createInvite,
  listInvites,
  listMembers,
  revokeInvite,
  storageOverview,
  updateMember,
} from './service';

const memberParamsSchema = z.object({ id: z.uuid() });

const inviteParamsSchema = z.object({ code: z.string().min(1).max(64) });

const updateMemberSchema = z.object({
  isActive: z.boolean().optional(),
  // A quota must be a positive safe integer; the API never stores a negative
  // or fractional allowance.
  uploadQuotaBytes: z.number().int().positive().max(Number.MAX_SAFE_INTEGER).optional(),
  password: z.string().min(10).max(128).optional(),
});

const createInviteSchema = z.object({
  expiresInHours: z.number().int().min(1).max(MAX_INVITE_HOURS).default(72),
});

/** Registers the administration endpoints; every route is admin-only. */
export function registerAdminRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);
  const requireAdmin = makeRequireAdmin();
  const adminOnly = { preHandler: [requireAuth, requireAdmin] };

  app.get('/api/admin/members', adminOnly, async () => {
    return { items: await listMembers(deps) };
  });

  app.patch('/api/admin/members/:id', adminOnly, async (request) => {
    const { id } = memberParamsSchema.parse(request.params);
    const patch = updateMemberSchema.parse(request.body);
    return updateMember(deps, request.user!.id, id, patch);
  });

  app.post('/api/admin/invites', adminOnly, async (request, reply) => {
    const { expiresInHours } = createInviteSchema.parse(request.body ?? {});
    const invite = await createInvite(deps, request.user!.id, expiresInHours);
    return reply.status(201).send(invite);
  });

  app.get('/api/admin/invites', adminOnly, async () => {
    return { items: await listInvites(deps) };
  });

  app.delete('/api/admin/invites/:code', adminOnly, async (request, reply) => {
    const { code } = inviteParamsSchema.parse(request.params);
    await revokeInvite(deps, request.user!.id, code);
    return reply.status(204).send();
  });

  app.get('/api/admin/storage', adminOnly, async () => {
    return storageOverview(deps);
  });
}
