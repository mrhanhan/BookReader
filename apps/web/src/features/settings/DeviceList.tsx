import { useState } from 'react';
import { Button, Dialog, Input } from '@bookr/ui';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { fetchDevices, renameDevice, revokeDevice } from '../../api/devices';
import type { DeviceItem } from '../../api/devices';
import { useAuth } from '../../app/auth';
import { messageForApiError } from '../../lib/errorMessages';
import { formatDateTime } from '../../lib/format';

const DEVICES_QUERY_KEY = ['devices'] as const;

const PLATFORM_LABELS: Record<string, string> = {
  web: '网页',
  ios: 'iOS',
  ipados: 'iPadOS',
  android: 'Android',
  macos: 'macOS',
  windows: 'Windows',
  linux: 'Linux',
  desktop: '桌面端',
};

function deviceName(device: DeviceItem): string {
  const name = device.name?.trim();
  return name ? name : '未命名设备';
}

function platformLabel(platform: string | null): string {
  if (platform === null || platform.trim() === '') return '未知平台';
  return PLATFORM_LABELS[platform.toLowerCase()] ?? platform;
}

/** Lists signed-in devices and offers rename and revoke for each one. */
export function DeviceList() {
  const { logout } = useAuth();
  const queryClient = useQueryClient();
  const devicesQuery = useQuery({ queryKey: DEVICES_QUERY_KEY, queryFn: fetchDevices });

  const renameMutation = useMutation({
    mutationFn: ({ id, name }: { id: string; name: string | null }) => renameDevice(id, name),
    onSuccess: (device) => {
      queryClient.setQueryData<DeviceItem[]>(DEVICES_QUERY_KEY, (current) =>
        current?.map((item) => (item.id === device.id ? device : item)),
      );
    },
  });

  const revokeMutation = useMutation({
    mutationFn: (id: string) => revokeDevice(id),
    onSuccess: (_result, id) => {
      queryClient.setQueryData<DeviceItem[]>(DEVICES_QUERY_KEY, (current) =>
        current?.filter((item) => item.id !== id),
      );
    },
  });

  const [renaming, setRenaming] = useState<DeviceItem | null>(null);
  const [renameValue, setRenameValue] = useState('');
  const [renameError, setRenameError] = useState<string | null>(null);
  const [revoking, setRevoking] = useState<DeviceItem | null>(null);
  const [revokeError, setRevokeError] = useState<string | null>(null);

  const devices = devicesQuery.data ?? [];

  function openRename(device: DeviceItem) {
    setRenameValue(device.name ?? '');
    setRenameError(null);
    setRenaming(device);
  }

  async function submitRename() {
    if (!renaming) return;
    const trimmed = renameValue.trim();
    if (trimmed.length > 60) {
      setRenameError('设备名称最多 60 个字符');
      return;
    }

    setRenameError(null);
    try {
      await renameMutation.mutateAsync({
        id: renaming.id,
        name: trimmed === '' ? null : trimmed,
      });
      setRenaming(null);
    } catch (caught) {
      setRenameError(messageForApiError(caught));
    }
  }

  async function confirmRevoke() {
    if (!revoking) return;
    setRevokeError(null);
    try {
      await revokeMutation.mutateAsync(revoking.id);
      const wasCurrent = revoking.current;
      setRevoking(null);
      // The session that revoked itself is over; send the user back to login.
      if (wasCurrent) await logout();
    } catch (caught) {
      setRevokeError(messageForApiError(caught));
    }
  }

  return (
    <section
      aria-labelledby="settings-devices-title"
      className="rounded-lg border border-border bg-surface/80 p-5"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h2 id="settings-devices-title" className="font-serif text-lg text-ink">
            设备
          </h2>
          <p className="mt-1 text-xs text-muted">
            这些设备仍保持着登录状态。撤销后需要重新登录才能继续同步。
          </p>
        </div>
        {devicesQuery.isFetching && !devicesQuery.isPending ? (
          <p role="status" className="text-xs text-muted">
            正在刷新设备…
          </p>
        ) : null}
      </div>

      {devicesQuery.isPending ? (
        <p role="status" className="py-8 text-center text-sm tracking-widest text-muted">
          正在读取设备…
        </p>
      ) : devicesQuery.isError ? (
        <div
          role="alert"
          className="mt-4 flex flex-col items-center gap-3 rounded-md border border-highlight/30 bg-highlight/10 px-4 py-6 text-center"
        >
          <p className="text-sm text-highlight">{messageForApiError(devicesQuery.error)}</p>
          <Button variant="ghost" size="sm" onClick={() => void devicesQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : devices.length === 0 ? (
        <p className="mt-4 rounded-md border border-dashed border-border px-4 py-6 text-center text-sm text-muted">
          暂无已登录设备。
        </p>
      ) : (
        <ul aria-label="已登录设备" className="mt-3 divide-y divide-border">
          {devices.map((device) => {
            const name = deviceName(device);
            return (
              <li
                key={device.id}
                className="flex flex-wrap items-start justify-between gap-3 py-3"
              >
                <div className="min-w-0">
                  <p className="flex flex-wrap items-center gap-2 text-sm text-ink">
                    <span className="truncate">{name}</span>
                    {device.current ? (
                      <span className="rounded-sm border border-accent/40 bg-accent/10 px-1.5 py-0.5 text-[10px] tracking-wider text-accent">
                        当前设备
                      </span>
                    ) : null}
                  </p>
                  <p className="mt-0.5 text-xs text-muted">
                    {platformLabel(device.platform)} · 最近活跃：
                    {device.lastSeenAt ? formatDateTime(device.lastSeenAt) : '暂无记录'}
                  </p>
                </div>
                <div className="flex items-center gap-1">
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`重命名 ${name}`}
                    onClick={() => openRename(device)}
                  >
                    重命名
                  </Button>
                  <Button
                    variant="ghost"
                    size="sm"
                    aria-label={`撤销 ${name}`}
                    onClick={() => {
                      setRevokeError(null);
                      setRevoking(device);
                    }}
                  >
                    撤销
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {renaming ? (
        <Dialog
          open
          onClose={() => {
            if (!renameMutation.isPending) setRenaming(null);
          }}
          title="重命名设备"
          footer={
            <>
              <Button
                variant="ghost"
                disabled={renameMutation.isPending}
                onClick={() => setRenaming(null)}
              >
                取消
              </Button>
              <Button
                loading={renameMutation.isPending}
                onClick={() => void submitRename()}
              >
                保存
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <Input
              label="设备名称"
              value={renameValue}
              maxLength={60}
              hint="留空则清除自定义名称"
              autoFocus
              onChange={(event) => {
                setRenameValue(event.target.value);
                setRenameError(null);
              }}
              onKeyDown={(event) => {
                if (event.key === 'Enter') {
                  event.preventDefault();
                  void submitRename();
                }
              }}
            />
            {renameError ? (
              <p role="alert" className="text-sm text-highlight">
                {renameError}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}

      {revoking ? (
        <Dialog
          open
          onClose={() => {
            if (!revokeMutation.isPending) setRevoking(null);
          }}
          title="撤销设备"
          footer={
            <>
              <Button
                variant="ghost"
                disabled={revokeMutation.isPending}
                onClick={() => setRevoking(null)}
              >
                取消
              </Button>
              <Button
                variant="danger"
                loading={revokeMutation.isPending}
                onClick={() => void confirmRevoke()}
              >
                确认撤销
              </Button>
            </>
          }
        >
          <div className="flex flex-col gap-3">
            <p className="text-sm leading-6 text-ink">
              撤销后，“{deviceName(revoking)}”需要重新登录才能继续同步。
            </p>
            {revoking.current ? (
              <p className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight">
                这是当前设备，撤销后你会立即退出登录。
              </p>
            ) : null}
            {revokeError ? (
              <p role="alert" className="text-sm text-highlight">
                {revokeError}
              </p>
            ) : null}
          </div>
        </Dialog>
      ) : null}
    </section>
  );
}
