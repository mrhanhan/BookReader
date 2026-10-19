import type { CategoryDto } from '@bookr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import type { QueryClient } from '@tanstack/react-query';
import { invalidateBookQueries } from './books';
import { apiFetch } from './client';

export const CATEGORIES_QUERY_KEY = ['categories'] as const;

export function fetchCategories(): Promise<CategoryDto[]> {
  return apiFetch<{ items: CategoryDto[] }>('/api/categories').then((page) => page.items);
}

export function useCategories() {
  return useQuery({
    queryKey: CATEGORIES_QUERY_KEY,
    queryFn: fetchCategories,
    staleTime: 5 * 60_000,
  });
}

export interface CreateCategoryInput {
  name: string;
  color: string;
}

/**
 * A category change repaints the badges on every book card, so the shelf and
 * the trash are refreshed alongside the category list itself.
 */
function refreshCategoryViews(queryClient: QueryClient): Promise<void> {
  return Promise.all([
    queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY }),
    invalidateBookQueries(queryClient),
  ]).then(() => undefined);
}

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      apiFetch<CategoryDto>('/api/categories', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    // A brand-new category is on no book yet, so only the list is stale.
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY }),
  });
}

/** Every field is optional; the server keeps whatever is left out. */
export interface UpdateCategoryInput {
  name?: string;
  color?: string;
  sortOrder?: number;
}

export function useUpdateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateCategoryInput }) =>
      apiFetch<CategoryDto>(`/api/categories/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () => refreshCategoryViews(queryClient),
  });
}

export function useDeleteCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (id: string) =>
      apiFetch<void>(`/api/categories/${id}`, { method: 'DELETE' }),
    onSuccess: () => refreshCategoryViews(queryClient),
  });
}

export function useReorderCategories() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (ids: string[]) =>
      apiFetch<void>('/api/categories/order', {
        method: 'PUT',
        body: JSON.stringify({ ids }),
      }),
    onSuccess: () => refreshCategoryViews(queryClient),
  });
}
