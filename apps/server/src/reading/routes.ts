import {
  createAnnotationSchema,
  createBookmarkSchema,
  updateAnnotationSchema,
  updateBookmarkSchema,
  updateProgressSchema,
} from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAuth } from '../auth/guards';
import {
  createAnnotation,
  deleteAnnotation,
  listAnnotations,
  updateAnnotation,
} from './annotations';
import {
  createBookmark,
  deleteBookmark,
  listBookmarks,
  updateBookmark,
} from './bookmarks';
import { getProgress, saveProgress } from './progress';

const bookIdParamsSchema = z.object({ id: z.uuid() });
const annotationParamsSchema = z.object({ id: z.uuid(), annotationId: z.uuid() });
const bookmarkParamsSchema = z.object({ id: z.uuid(), bookmarkId: z.uuid() });

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

  app.get('/api/books/:id/annotations', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return { items: await listAnnotations(deps, request.user!.id, id) };
  });

  app.post('/api/books/:id/annotations', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    const input = createAnnotationSchema.parse(request.body);
    const annotation = await createAnnotation(deps, request.user!, id, input);
    return reply.status(201).send({ annotation });
  });

  app.patch(
    '/api/books/:id/annotations/:annotationId',
    { preHandler: requireAuth },
    async (request) => {
      const { id, annotationId } = annotationParamsSchema.parse(request.params);
      const input = updateAnnotationSchema.parse(request.body);
      return updateAnnotation(deps, request.user!, id, annotationId, input);
    },
  );

  app.delete(
    '/api/books/:id/annotations/:annotationId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, annotationId } = annotationParamsSchema.parse(request.params);
      await deleteAnnotation(deps, request.user!, id, annotationId);
      return reply.status(204).send();
    },
  );

  app.get('/api/books/:id/bookmarks', { preHandler: requireAuth }, async (request) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    return { items: await listBookmarks(deps, request.user!.id, id) };
  });

  app.post('/api/books/:id/bookmarks', { preHandler: requireAuth }, async (request, reply) => {
    const { id } = bookIdParamsSchema.parse(request.params);
    const input = createBookmarkSchema.parse(request.body);
    const bookmark = await createBookmark(deps, request.user!, id, input);
    return reply.status(201).send({ bookmark });
  });

  app.patch(
    '/api/books/:id/bookmarks/:bookmarkId',
    { preHandler: requireAuth },
    async (request) => {
      const { id, bookmarkId } = bookmarkParamsSchema.parse(request.params);
      const input = updateBookmarkSchema.parse(request.body);
      return { bookmark: await updateBookmark(deps, request.user!, id, bookmarkId, input) };
    },
  );

  app.delete(
    '/api/books/:id/bookmarks/:bookmarkId',
    { preHandler: requireAuth },
    async (request, reply) => {
      const { id, bookmarkId } = bookmarkParamsSchema.parse(request.params);
      await deleteBookmark(deps, request.user!, id, bookmarkId);
      return reply.status(204).send();
    },
  );
}
