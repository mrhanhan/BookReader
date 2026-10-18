import { SYNC_PULL_DEFAULT_LIMIT } from '@bookr/shared';
import type {
  SyncPullResult,
  SyncPushChange,
  SyncPushResult,
  SyncSnapshot,
} from '@bookr/shared';
import { apiFetch, apiUrl } from './client';

/** HTTP surface of the sync endpoints. */
export interface SyncApi {
  push(changes: SyncPushChange[]): Promise<SyncPushResult>;
  pull(since: number, limit?: number): Promise<SyncPullResult>;
  snapshot(): Promise<SyncSnapshot>;
  streamToken(): Promise<{ token: string; expiresIn: number }>;
}

export function createSyncApi(): SyncApi {
  return {
    push(changes) {
      return apiFetch<SyncPushResult>('/api/sync/push', {
        method: 'POST',
        body: JSON.stringify({ changes }),
      });
    },

    pull(since, limit) {
      const query = new URLSearchParams({
        since: String(since),
        limit: String(limit ?? SYNC_PULL_DEFAULT_LIMIT),
      });
      return apiFetch<SyncPullResult>(`/api/sync/pull?${query.toString()}`);
    },

    snapshot() {
      return apiFetch<SyncSnapshot>('/api/sync/snapshot');
    },

    streamToken() {
      return apiFetch<{ token: string; expiresIn: number }>('/api/sync/stream-token', {
        method: 'POST',
      });
    },
  };
}

/** SSE endpoints cannot send an Authorization header, so the short-lived token is a query parameter. */
export function syncStreamUrl(token: string, since: number): string {
  return apiUrl(`/api/sync/stream?token=${encodeURIComponent(token)}&since=${since}`);
}
