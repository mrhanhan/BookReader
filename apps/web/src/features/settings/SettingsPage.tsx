import { useState } from 'react';
import type { AiUsageDto } from '@bookr/shared';
import { Button } from '@bookr/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchAiUsage, setAiEnabled } from '../../api/ai';
import { updateTimezone } from '../../api/auth';
import { statsQueryKey } from '../../api/stats';
import { useAuth } from '../../app/auth';
import { formatDateTime } from '../../lib/format';
import { useSync } from '../../sync/SyncProvider';
import { DeviceList } from './DeviceList';
import { OfflineCachePanel } from './OfflineCachePanel';
import { SyncStatusBadge } from './SyncStatusBadge';
import { TIMEZONE_OPTIONS } from './timezones';

/** Verbatim privacy promise shown with the AI switch. */
const AI_PRIVACY_NOTE =
  'AI 请求只包含选中文字、当前页或本章的必要片段以及书名作者，不会发送整本书；服务商 Key 只保存在服务器。关闭后不会再发起任何 AI 请求。';

const formatTokens = (value: number): string => value.toLocaleString('zh-CN');

/** Today's and this month's quota; the suffix warns when either window is spent. */
function quotaLine(usage: AiUsageDto): string {
  const daily = `今日 ${formatTokens(usage.daily.used)} / ${formatTokens(usage.daily.limit)} tokens`;
  const monthly = `本月 ${formatTokens(usage.monthly.used)} / ${formatTokens(usage.monthly.limit)} tokens`;
  // Reserved tokens already count against the limit on the server.
  const exhausted =
    usage.daily.used + usage.daily.reserved >= usage.daily.limit ||
    usage.monthly.used + usage.monthly.reserved >= usage.monthly.limit;
  return `${daily} · ${monthly}${exhausted ? '（额度已用尽）' : ''}`;
}

function AiSettingsSection() {
  const { refreshUser } = useAuth();
  const queryClient = useQueryClient();
  // The checkbox flips immediately; the server value replaces the local one
  // once the refetch lands. A failed save restores the previous state.
  const [pendingEnabled, setPendingEnabled] = useState<boolean | null>(null);
  const usageQuery = useQuery({ queryKey: ['ai-usage'], queryFn: fetchAiUsage });
  const toggle = useMutation({
    mutationFn: setAiEnabled,
    onSuccess: async (saved) => {
      // Keep the server-confirmed value even if the usage refetch fails.
      queryClient.setQueryData<AiUsageDto>(['ai-usage'], (old) =>
        old ? { ...old, enabled: saved } : old,
      );
      // The server stored the switch already; a failed profile refresh must
      // not report the save as failed or leave the quota stale.
      try {
        await refreshUser();
      } catch {
        // The next verified profile fetch will catch up.
      }
      await queryClient.invalidateQueries({ queryKey: ['ai-usage'] });
      setPendingEnabled(null);
    },
    onError: () => setPendingEnabled(null),
  });

  const usage = usageQuery.data;
  const enabled = pendingEnabled ?? usage?.enabled ?? false;

  return (
    <section
      aria-labelledby="settings-ai-title"
      className="rounded-lg border border-border bg-surface/80 p-5"
    >
      <h2 id="settings-ai-title" className="font-serif text-lg text-ink">
        AI 伴读
      </h2>
      <p className="mt-1 text-xs text-muted">{AI_PRIVACY_NOTE}</p>

      {usageQuery.isPending ? (
        <p className="mt-4 text-xs text-muted">正在读取 AI 状态…</p>
      ) : usageQuery.isError || !usage ? (
        <p role="alert" className="mt-4 text-xs text-highlight">
          无法读取 AI 状态，请稍后重试
        </p>
      ) : (
        <div className="mt-4 flex flex-col gap-3 text-sm">
          <label className="flex items-center gap-2 text-ink">
            <input
              type="checkbox"
              aria-label="启用 AI 伴读"
              checked={enabled}
              disabled={toggle.isPending || !usage.configured}
              onChange={(event) => {
                const next = event.target.checked;
                setPendingEnabled(next);
                toggle.mutate(next);
              }}
              className="size-4 rounded border-border accent-accent"
            />
            启用 AI 伴读
          </label>

          {toggle.isError ? (
            <p role="alert" className="text-xs text-highlight">
              AI 开关保存失败，请重试
            </p>
          ) : null}

          {usage.configured === false ? (
            <p className="text-xs text-muted">AI 尚未配置，请联系管理员</p>
          ) : null}

          {usage.fakeProvider ? (
            <p className="text-xs text-muted">当前使用本地假提供方（仅用于测试）</p>
          ) : null}

          <p className="tabular-nums text-xs text-muted">{quotaLine(usage)}</p>
        </div>
      )}
    </section>
  );
}


/** Statistics timezone; saving rebuilds the user's daily aggregates. */
export function TimezoneSettingsSection() {
  const { user, refreshUser } = useAuth();
  const queryClient = useQueryClient();
  // The attempted value stays visible after a failure so the user can retry
  // without reselecting it.
  const [pending, setPending] = useState<string | null>(null);
  const [saved, setSaved] = useState(false);
  const mutation = useMutation({
    mutationFn: updateTimezone,
    onSuccess: async () => {
      setPending(null);
      setSaved(true);
      try {
        await refreshUser();
      } catch {
        // The next verified profile fetch will catch up.
      }
      await queryClient.invalidateQueries({ queryKey: statsQueryKey });
    },
    onError: () => setSaved(false),
  });

  const current = pending ?? user?.timezone ?? 'Asia/Shanghai';
  const options = TIMEZONE_OPTIONS.some((option) => option.value === current)
    ? TIMEZONE_OPTIONS
    : [...TIMEZONE_OPTIONS, { value: current, label: current }];

  return (
    <section
      aria-labelledby="settings-timezone-title"
      className="rounded-lg border border-border bg-surface/80 p-5"
    >
      <h2 id="settings-timezone-title" className="font-serif text-lg text-ink">
        阅读统计
      </h2>
      <p className="mt-1 text-xs text-muted">
        统计按此时区划分自然日，跨时区旅行不会重复计时。
      </p>

      <label className="mt-4 flex flex-col gap-1 text-sm text-ink">
        <span className="text-xs tracking-wide text-muted">统计时区</span>
        <select
          aria-label="统计时区"
          value={current}
          disabled={mutation.isPending}
          onChange={(event) => {
            const next = event.target.value;
            setSaved(false);
            setPending(next);
            mutation.mutate(next);
          }}
          className="min-h-11 w-full rounded-md border border-border bg-surface px-3 py-2 text-sm text-ink focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent sm:max-w-xs"
        >
          {options.map((option) => (
            <option key={option.value} value={option.value}>
              {option.label} · {option.value}
            </option>
          ))}
        </select>
      </label>

      {saved && !mutation.isPending ? (
        <p role="status" className="mt-2 text-xs text-accent">
          已保存
        </p>
      ) : null}
      {mutation.isError ? (
        <p role="alert" className="mt-2 text-xs text-highlight">
          时区保存失败，请重试
        </p>
      ) : null}
      {mutation.isError && pending !== null ? (
        <Button
          variant="ghost"
          size="sm"
          className="mt-2"
          onClick={() => mutation.mutate(pending)}
        >
          重试
        </Button>
      ) : null}
    </section>
  );
}

/** Account settings: sync state, offline copies, AI companion and signed-in devices. */
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
        <p className="mt-1 text-sm text-muted">
          同步状态、离线缓存、AI 伴读与已登录设备都在这里管理。
        </p>
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

      <TimezoneSettingsSection />
      <AiSettingsSection />
      <OfflineCachePanel />
      <DeviceList />
    </div>
  );
}
