import { useState } from 'react';
import { Button } from '@bookr/ui';
import { formatDateTime } from '../../lib/format';
import { useSync } from '../../sync/SyncProvider';
import { DeviceList } from './DeviceList';
import { OfflineCachePanel } from './OfflineCachePanel';
import { SyncStatusBadge } from './SyncStatusBadge';

/** Account settings: sync state, offline copies and signed-in devices. */
export function SettingsPage() {
  const { state, syncNow } = useSync();
  const [syncing, setSyncing] = useState(false);

  async function handleSyncNow() {
    setSyncing(true);
    try {
      await syncNow('settings');
    } finally {
      setSyncing(false);
    }
  }

  const lastSyncedAt =
    state.lastSyncedAt === null
      ? null
      : formatDateTime(new Date(state.lastSyncedAt).toISOString());

  return (
    <div className="flex flex-col gap-6">
      <header>
        <h1 className="font-serif text-2xl text-ink">设置</h1>
        <p className="mt-1 text-sm text-muted">同步状态、离线缓存与已登录设备都在这里管理。</p>
      </header>

      <section
        aria-labelledby="settings-sync-title"
        className="rounded-lg border border-border bg-surface/80 p-5"
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <h2 id="settings-sync-title" className="font-serif text-lg text-ink">
              同步
            </h2>
            <p className="mt-1 text-xs text-muted">
              阅读进度、批注和书签会在联网时自动同步。
            </p>
          </div>
          <Button variant="ghost" size="sm" loading={syncing} onClick={() => void handleSyncNow()}>
            立即同步
          </Button>
        </div>

        <dl className="mt-4 grid gap-4 text-sm sm:grid-cols-3">
          <div>
            <dt className="text-xs tracking-wide text-muted">当前状态</dt>
            <dd className="mt-1">
              <SyncStatusBadge />
            </dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-muted">待同步变更</dt>
            <dd className="mt-1 tabular-nums text-ink">{state.pending} 项</dd>
          </div>
          <div>
            <dt className="text-xs tracking-wide text-muted">上次同步</dt>
            <dd className="mt-1 text-ink">
              {lastSyncedAt === null ? '尚未同步' : lastSyncedAt}
            </dd>
          </div>
        </dl>

        {state.status === 'error' ? (
          <p role="alert" className="mt-3 text-xs text-highlight">
            同步失败，请检查网络后重试。
          </p>
        ) : null}
      </section>

      <OfflineCachePanel />
      <DeviceList />
    </div>
  );
}
