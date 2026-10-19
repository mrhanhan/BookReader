import type { ReadingStatsDto } from '@bookr/shared';
import { apiFetch } from './client';

/** Query key shared by the stats page and the timezone setting. */
export const statsQueryKey = ['stats'] as const;

/** Reads the caller's own statistics; the endpoint is read-only. */
export function fetchStats(): Promise<ReadingStatsDto> {
  return apiFetch<ReadingStatsDto>('/api/stats');
}
