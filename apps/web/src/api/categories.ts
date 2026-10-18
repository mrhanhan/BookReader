import type { CategoryDto } from '@bookr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
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

export function useCreateCategory() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: CreateCategoryInput) =>
      apiFetch<CategoryDto>('/api/categories', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () => queryClient.invalidateQueries({ queryKey: CATEGORIES_QUERY_KEY }),
  });
}
