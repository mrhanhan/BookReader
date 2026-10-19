import type {
  AdminStorageOverviewDto,
  AuditLogPageDto,
  BackupStatusDto,
  Role,
  SystemSettingsDto,
  UpdateSystemSettingsInput,
} from '@bookr/shared';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { apiFetch } from './client';

/** Query-key prefixes for the administration screens. */
export const ADMIN_MEMBERS_QUERY_KEY = ['admin', 'members'] as const;
export const ADMIN_INVITES_QUERY_KEY = ['admin', 'invites'] as const;
export const ADMIN_STORAGE_QUERY_KEY = ['admin', 'storage'] as const;
export const ADMIN_SETTINGS_QUERY_KEY = ['admin', 'settings'] as const;
export const ADMIN_AUDIT_QUERY_KEY = ['admin', 'audit'] as const;
export const ADMIN_BACKUP_QUERY_KEY = ['admin', 'backup'] as const;
export const ADMIN_AI_QUERY_KEY = ['admin', 'ai'] as const;

/** A member as returned by `GET /api/admin/members`. */
export interface AdminMember {
  id: string;
  username: string;
  displayName: string;
  role: Role;
  isActive: boolean;
  uploadQuotaBytes: number;
  aiEnabled: boolean;
  aiDailyTokenLimit: number;
  aiMonthlyTokenLimit: number;
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
export type StorageOverview = AdminStorageOverviewDto;

/** Fields an administrator may change on one member. */
export interface UpdateMemberInput {
  isActive?: boolean;
  uploadQuotaBytes?: number;
  aiEnabled?: boolean;
  aiDailyTokenLimit?: number;
  aiMonthlyTokenLimit?: number;
  password?: string;
}

/** Administrator-facing AI provider configuration; never carries the key. */
export interface AdminAiConfig {
  configured: boolean;
  fakeProvider: boolean;
  baseUrl: string | null;
  chatModel: string | null;
  reasonerModel: string | null;
  hasApiKey: boolean;
  updatedAt: string | null;
}

/** Values an administrator may change on the AI provider. */
export interface UpdateAdminAiConfig {
  baseUrl?: string;
  chatModel?: string;
  reasonerModel?: string;
  apiKey?: string;
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

/** Home-wide registration switch and default timezone for new accounts. */
export function useSystemSettings() {
  return useQuery({
    queryKey: ADMIN_SETTINGS_QUERY_KEY,
    queryFn: () => apiFetch<SystemSettingsDto>('/api/admin/settings'),
  });
}

export function useUpdateSystemSettings() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateSystemSettingsInput) =>
      apiFetch<SystemSettingsDto>('/api/admin/settings', {
        method: 'PATCH',
        body: JSON.stringify(input),
      }),
    onSuccess: (saved) => {
      // The response already holds the saved values; invalidating keeps any
      // other administrator's tab in step as well.
      queryClient.setQueryData(ADMIN_SETTINGS_QUERY_KEY, saved);
      return queryClient
        .invalidateQueries({ queryKey: ADMIN_SETTINGS_QUERY_KEY })
        .then(() => undefined);
    },
  });
}

/** One page of the append-only audit ledger. */
export function useAuditLog(page: number, pageSize = 20) {
  return useQuery({
    queryKey: [...ADMIN_AUDIT_QUERY_KEY, page, pageSize],
    queryFn: () =>
      apiFetch<AuditLogPageDto>(`/api/admin/audit?page=${page}&pageSize=${pageSize}`),
  });
}

/** Latest backup heartbeat, report ledger and alert deliveries. */
export function useBackupStatus() {
  return useQuery({
    queryKey: ADMIN_BACKUP_QUERY_KEY,
    queryFn: () => apiFetch<BackupStatusDto>('/api/admin/backup'),
  });
}

export function useAdminAiConfig() {
  return useQuery({
    queryKey: ADMIN_AI_QUERY_KEY,
    queryFn: () => apiFetch<AdminAiConfig>('/api/admin/ai'),
  });
}

export function useUpdateAdminAiConfig() {
  const queryClient = useQueryClient();
  return useMutation({
    mutationFn: (input: UpdateAdminAiConfig) =>
      apiFetch<AdminAiConfig>('/api/admin/ai', {
        method: 'PUT',
        body: JSON.stringify(input),
      }),
    onSuccess: (saved) => {
      queryClient.setQueryData(ADMIN_AI_QUERY_KEY, saved);
      return queryClient.invalidateQueries({ queryKey: ADMIN_AI_QUERY_KEY }).then(() => undefined);
    },
  });
}
