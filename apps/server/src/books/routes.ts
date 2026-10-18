import { ERROR_CODES, listBooksQuerySchema, updateBookSchema } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { AppError } from '../errors';
import {
  getBook,
  listBooks,
  listTrash,
  replaceCover,
  restoreBook,
  softDeleteBook,
  updateBook,
} from './service';

const bookIdParamsSchema = z.object({ id: z.uuid() });

/** Registers the shared bookshelf and trash endpoints. */
export function registerBookRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);

  app.get('/api/books', { preHandler: requireAuth }, async (request) => {
    const query = listBooksQuerySchema.parse(request.query);
    return listBooks(deps, query);
  });

  app.get('/api/books/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return { book: await getBook(deps, id) };
  });

  app.patch('/api/books/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    const patch = updateBookSchema.parse(request.body);
    return { book: await updateBook(deps, request.user!, id, patch) };
  });

  app.delete('/api/books/:id', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    await softDeleteBook(deps, request.user!, id);
    return reply.status(204).send();
  });

  app.post('/api/books/:id/restore', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return { book: await restoreBook(deps, request.user!, id) };
  });

  app.get('/api/trash', { preHandler: requireAuth }, async () => {
    return { items: await listTrash(deps) };
  });

  app.post('/api/books/:id/cover', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    const part = await request.file();
    if (!part) {
      throw new AppError(400, ERROR_CODES.VALIDATION_FAILED, undefined, 'A cover image is required');
    }
    const buffer = await part.toBuffer();
    return replaceCover(deps, request.user!, id, { buffer, contentType: part.mimetype });
  });
}
