import { useContext } from 'react';
import type { SyncState, SyncStatus } from './engine';
import { DEFAULT_SYNC_STATE, SyncContext } from './SyncProvider';

export const SYNC_STATUS_LABELS: Record<SyncStatus, string> = {
  synced: '已同步',
  syncing: '同步中',
  pending: '待同步',
  offline: '离线待同步',
  error: '同步失败',
};

/** Formats the badge label, including the queued count where it matters. */
export function syncStatusLabel(state: SyncState): string {
  const label = SYNC_STATUS_LABELS[state.status];
  if ((state.status === 'pending' || state.status === 'offline') && state.pending > 0) {
    return `${label} ${state.pending} 项`;
  }
  return label;
}

/**
 * Reads sync state even outside a provider (the reader renders its chrome in
 * isolation tests); without a provider there is nothing to synchronise.
 */
export function useSyncStatus(): SyncState {
  const context = useContext(SyncContext);
  return context?.state ?? DEFAULT_SYNC_STATE;
}
