import {
  ERROR_CODES,
  createCategorySchema,
  updateCategorySchema,
  type CategoryDto,
} from '@bookr/shared';
import { and, asc, eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { AppDeps } from '../app';
import { makeRequireAdmin, makeRequireAuth } from '../auth/guards';
import { categories } from '../db/schema';
import { AppError } from '../errors';
import { LIBRARY_ID, getLibrary } from '../library/service';

const categoryIdParamsSchema = z.object({ id: z.uuid() });

const categoryDtoColumns = {
  id: categories.id,
  name: categories.name,
  color: categories.color,
};

function toCategoryDto(row: CategoryDto): CategoryDto {
  return { id: row.id, name: row.name, color: row.color };
}

/**
 * Registers category CRUD. Every active member can create a category and read
 * the shared list; renaming, recoloring, reordering and deleting are admin-only.
 * Deleting relies on the `book_categories` foreign key cascade and never
 * touches `books`.
 */
export function registerCategoryRoutes(app: FastifyInstance, deps: AppDeps): void {
  const requireAuth = makeRequireAuth(deps);
  const requireAdmin = makeRequireAdmin();

  app.get('/api/categories', { preHandler: requireAuth }, async () => {
    const rows = await deps.db
      .select(categoryDtoColumns)
      .from(categories)
      .where(eq(categories.libraryId, LIBRARY_ID))
      .orderBy(asc(categories.sortOrder), asc(categories.name), asc(categories.id));
    return { items: rows.map(toCategoryDto) };
  });

  app.post('/api/categories', { preHandler: requireAuth }, async (request, reply) => {
    const input = createCategorySchema.parse(request.body);
    const library = await getLibrary(deps);
    const [row] = await deps.db
      .insert(categories)
      .values({
        libraryId: library.id,
        name: input.name,
        color: input.color,
        createdBy: request.user!.id,
      })
      .returning(categoryDtoColumns);

    return reply.status(201).send(toCategoryDto(row!));
  });

  app.patch(
    '/api/categories/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request) => {
      const { id } = categoryIdParamsSchema.parse(request.params);
      const patch = updateCategorySchema.parse(request.body);
      if (Object.keys(patch).length === 0) {
        throw new AppError(
          400,
          ERROR_CODES.VALIDATION_FAILED,
          undefined,
          'At least one category field is required',
        );
      }

      const [row] = await deps.db
        .update(categories)
        .set(patch)
        .where(and(eq(categories.id, id), eq(categories.libraryId, LIBRARY_ID)))
        .returning(categoryDtoColumns);

      if (!row) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND);
      }
      return toCategoryDto(row);
    },
  );

  app.delete(
    '/api/categories/:id',
    { preHandler: [requireAuth, requireAdmin] },
    async (request, reply) => {
      const { id } = categoryIdParamsSchema.parse(request.params);
      const deleted = await deps.db
        .delete(categories)
        .where(and(eq(categories.id, id), eq(categories.libraryId, LIBRARY_ID)))
        .returning({ id: categories.id });

      if (deleted.length === 0) {
        throw new AppError(404, ERROR_CODES.NOT_FOUND);
      }
      return reply.status(204).send();
    },
  );
}
