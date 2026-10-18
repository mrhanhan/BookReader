import type { Role } from '@bookr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/** Query-key prefixes for the administration screens. */
export const ADMIN_MEMBERS_QUERY_KEY = ['admin', 'members'] as const;
export const ADMIN_INVITES_QUERY_KEY = ['admin', 'invites'] as const;
export const ADMIN_STORAGE_QUERY_KEY = ['admin', 'storage'] as const;

/** A member as returned by `GET /api/admin/members`. */
export interface AdminMember {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  uploadQuotaBytes: number;
  usedBytes: number;
  createdAt: string;
}

/** An invite as returned by `GET /api/admin/invites`. */
export interface AdminInvite {
  code: string;
  expiresAt: string;
  usedBy: string | null;
  revokedAt: string | null;
}

/** The freshly minted invite returned by `POST /api/admin/invites`. */
export interface CreatedInvite {
  code: string;
  expiresAt: string;
}

/** Shared-pool usage for the administration screen. */
export interface StorageOverview {
  totalBytes: number;
  usedBytes: number;
  perMember: Array<{ userId: string; displayName: string; usedBytes: number }>;
}

/** Fields an administrator may change on one member. */
export interface UpdateMemberInput {
  isActive?: boolean;
  uploadQuotaBytes?: number;
  password?: string;
}

export function useMembers() {
  return useQuery({
    queryKey: ADMIN_MEMBERS_QUERY_KEY,
    queryFn: async () =>
      (await apiFetch<{ items: AdminMember[] }>('/api/admin/members')).items,
  });
}

/**
 * Applies a member edit. Quotas and active state both feed the storage
 * overview, so both caches are refreshed after a successful patch.
 */
export function useUpdateMember() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: ({ id, patch }: { id: string; patch: UpdateMemberInput }) =>
      apiFetch<AdminMember>(`/api/admin/members/${id}`, {
        method: 'PATCH',
        body: JSON.stringify(patch),
      }),
    onSuccess: () =>
      Promise.all([
        queryClient.invalidateQueries({ queryKey: ADMIN_MEMBERS_QUERY_KEY }),
        queryClient.invalidateQueries({ queryKey: ADMIN_STORAGE_QUERY_KEY }),
      ]).then(() => undefined),
  });
}

export function useInvites() {
  return useQuery({
    queryKey: ADMIN_INVITES_QUERY_KEY,
    queryFn: async () => (await apiFetch<{ items: AdminInvite[] }>('/api/admin/invites')).items,
  });
}

export function useCreateInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: { expiresInHours?: number } = {}) =>
      apiFetch<CreatedInvite>('/api/admin/invites', {
        method: 'POST',
        body: JSON.stringify(input),
      }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY }).then(() => undefined),
  });
}

export function useRevokeInvite() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (code: string) =>
      apiFetch<void>(`/api/admin/invites/${encodeURIComponent(code)}`, { method: 'DELETE' }),
    onSuccess: () =>
      queryClient.invalidateQueries({ queryKey: ADMIN_INVITES_QUERY_KEY }).then(() => undefined),
  });
}

export function useStorageOverview() {
  return useQuery({
    queryKey: ADMIN_STORAGE_QUERY_KEY,
    queryFn: () => apiFetch<StorageOverview>('/api/admin/storage'),
  });
}
