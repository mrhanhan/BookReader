import { apiFetch } from './client';

/** A signed-in device as returned by `GET /api/devices`. */
export interface DeviceItem {
  id: string;
  name: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** True for the device that issued the current access token. */
  current: boolean;
}

/** Lists the caller's active devices, newest first. */
export async function fetchDevices(): Promise<DeviceItem[]> {
  return (await apiFetch<{ items: DeviceItem[] }>('/api/devices')).items;
}

/** Renames a device; `null` clears the custom name. */
export async function renameDevice(id: string, name: string | null): Promise<DeviceItem> {
  const response = await apiFetch<{ device: DeviceItem }>(
    `/api/devices/${encodeURIComponent(id)}`,
    {
      method: 'PATCH',
      body: JSON.stringify({ name }),
    },
  );
  return response.device;
}

/** Revokes a device, invalidating its refresh token and access tokens. */
export async function revokeDevice(id: string): Promise<void> {
  await apiFetch<void>(`/api/devices/${encodeURIComponent(id)}`, { method: 'DELETE' });
}
