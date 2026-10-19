import { z } from 'zod';

/** A book category as embedded in book payloads. */
export interface CategoryDto {
  id: string;
  name: string;
  color: string;
}

const colorSchema = z.string().regex(/^#[0-9a-fA-F]{6}$/);

export const createCategorySchema = z.object({
  name: z.string().min(1).max(30),
  color: colorSchema,
});

export const updateCategorySchema = createCategorySchema
  .extend({ sortOrder: z.number().int().min(0) })
  .partial();

export const reorderCategoriesSchema = z.object({
  ids: z
    .array(z.uuid())
    .min(1)
    .refine((ids) => new Set(ids).size === ids.length, {
      message: 'Category ids must be unique',
    }),
});

export type ReorderCategoriesInput = z.infer<typeof reorderCategoriesSchema>;
