import { createUploadSchema, type CompleteUploadResponse, type CreateUploadResponse } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { completeUpload, createUpload } from './service';

const uploadIdParamsSchema = z.object({ id: z.uuid() });

/** Registers the presigned upload endpoints. */
export function registerUploadRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.post('/api/uploads', { preHandler: requireAuth }, async (request, reply) => {
    const input = createUploadSchema.parse(request.body);
    const created: CreateUploadResponse = await createUpload(deps, request.user!.id, input);
    return reply.status(201).send(created);
  });

  app.post('/api/uploads/:id/complete', { preHandler: requireAuth }, async (request) => {
    const { id } = uploadIdParamsSchema.parse(request.params);
    const book = await completeUpload(deps, request.user!.id, id);
    const response: CompleteUploadResponse = { book };
    return response;
  });
}
