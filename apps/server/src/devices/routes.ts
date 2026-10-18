import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { listDevices, renameDevice, revokeDevice } from './service';

const deviceParamsSchema = z.object({ id: z.uuid() });

/** Body of a rename; a blank name is invalid, an explicit null clears it. */
const renameDeviceSchema = z.object({
  name: z.string().trim().min(1).max(60).nullable(),
});

/** Registers the per-user device management endpoints. */
export function registerDeviceRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.get('/api/devices', { preHandler: requireAuth }, async (request) => {
    const user = request.user!;
    return { items: await listDevices(deps, user.id, user.deviceId) };
  });

  app.patch('/api/devices/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = deviceParamsSchema.parse(request.params);
    const { name } = renameDeviceSchema.parse(request.body);
    const user = request.user!;
    return {
      device: await renameDevice(deps, user.id, id, name, user.deviceId),
    };
  });

  app.delete('/api/devices/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = deviceParamsSchema.parse(request.params);
    await revokeDevice(deps, request.user!.id, id, deps.clock.now());
    return reply.status(204).send();
  });
}
