import {
  ERROR_CODES,
  listBooksQuerySchema,
  reflowUploadCreateSchema,
  updateBookSchema,
} from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import { AppError } from '../errors';
import { retryConversion } from './conversion';
import { getReaderFile } from './reader-file';
import {
  completeReflowUpload,
  createReflowUpload,
  deleteReflowPack,
  getReflowFile,
} from './reflow';
import {
  assertCanManageBook,
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
    return listBooks(deps, query, request.user!.id);
  });

  app.get('/api/books/:id', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return { book: await getBook(deps, id, request.user!.id) };
  });

  // Files are shared like the shelf itself: any active member can open any
  // live book, while notes and progress stay private per user.
  app.get('/api/books/:id/file', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return getReaderFile(deps, id);
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

  // Retrying a conversion is limited to the uploader or an admin; the route
  // only queues work, so 202 is the honest response.
  app.post('/api/books/:id/convert', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    await retryConversion(deps, request.user!, id);
    return reply.status(202).send({ queued: true });
  });

  app.get('/api/trash', { preHandler: requireAuth }, async (request) => {
    return { items: await listTrash(deps, request.user!.id) };
  });

  // Reflow packs are shared with every member like the book itself, but only
  // the uploader or an admin may replace or remove one.
  app.post('/api/books/:id/reflow/uploads', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    const input = reflowUploadCreateSchema.parse(request.body);
    return reply.status(201).send(await createReflowUpload(deps, request.user!, id, input));
  });

  app.post(
    '/api/books/:id/reflow/uploads/:uploadId/complete',
    { preHandler: requireAuth },
    async (request) => {
      const params = z.object({ id: z.uuid(), uploadId: z.uuid() }).parse(request.params);
      return completeReflowUpload(deps, request.user!, params.id, params.uploadId);
    },
  );

  app.get('/api/books/:id/reflow', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return getReflowFile(deps, id);
  });

  app.delete('/api/books/:id/reflow', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    await deleteReflowPack(deps, request.user!, id);
    return reply.status(204).send();
  });

  // The permission check runs in `onRequest`, before the multipart body is
  // parsed, so an unauthorized caller cannot make the server buffer an image.
  app.post(
    '/api/books/:id/cover',
    {
      onRequest: [
        requireAuth,
        async (request) => {
          const { id } = bookIdParamsSchema.parse(request.params);
          await assertCanManageBook(deps, request.user!, id);
        },
      ],
    },
    async (request) => {
      const { id } = bookIdParamsSchema.parse(request.params);
      const part = await request.file();
      if (!part) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          undefined,
          'A cover image is required',
        );
      }
      const buffer = await part.toBuffer();
      return replaceCover(deps, request.user!, id, { buffer, contentType: part.mimetype });
    },
  );
}
