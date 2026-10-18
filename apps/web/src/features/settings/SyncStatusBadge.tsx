import { cn } from '@bookr/ui';
import type { SyncStatus } from '../../sync/engine';
import { syncStatusLabel, useSyncStatus } from '../../sync/useSyncStatus';

const DOT_CLASS: Record<SyncStatus, string> = {
  synced: 'bg-emerald-600',
  syncing: 'bg-muted/60',
  pending: 'bg-accent',
  offline: 'bg-amber-500',
  error: 'bg-red-500',
};

export interface SyncStatusBadgeProps {
  className?: string;
}

/** Dot plus label announcing the sync state to assistive technology. */
export function SyncStatusBadge({ className }: SyncStatusBadgeProps) {
  const state = useSyncStatus();

  return (
    <span
      role="status"
      aria-live="polite"
      className={cn('inline-flex items-center gap-1.5 text-xs text-muted', className)}
    >
      <span
        aria-hidden="true"
        className={cn('inline-block h-2 w-2 rounded-full', DOT_CLASS[state.status])}
      />
      {syncStatusLabel(state)}
    </span>
  );
}
