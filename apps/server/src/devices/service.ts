import { ERROR_CODES } from '@bookr/shared';
import { and, desc, eq, isNull } from 'drizzle-orm';
import type { AppDeps } from '../app';
import { devices } from '../db/schema';
import { AppError } from '../errors';

type DeviceRow = typeof devices.$inferSelect;

/** A signed-in device as exposed to its owner. */
export interface DeviceDto {
  id: string;
  name: string | null;
  platform: string | null;
  lastSeenAt: string | null;
  createdAt: string;
  /** True for the device that issued the current access token. */
  current: boolean;
}

function toDeviceDto(row: DeviceRow, currentDeviceId: string | undefined): DeviceDto {
  return {
    id: row.id,
    name: row.name,
    platform: row.platform,
    lastSeenAt: row.lastSeenAt ? row.lastSeenAt.toISOString() : null,
    createdAt: row.createdAt.toISOString(),
    current: currentDeviceId === row.id,
  };
}

/** Lists the caller's active devices, newest first. */
export async function listDevices(
  deps: AppDeps,
  userId: string,
  currentDeviceId?: string,
): Promise<DeviceDto[]> {
  const rows = await deps.db
    .select()
    .from(devices)
    .where(and(eq(devices.userId, userId), isNull(devices.revokedAt)))
    .orderBy(desc(devices.createdAt), desc(devices.id));
  return rows.map((row) => toDeviceDto(row, currentDeviceId));
}

/**
 * Renames one of the caller's devices. Another user's device is a 404 so its
 * existence is never revealed.
 */
export async function renameDevice(
  deps: AppDeps,
  userId: string,
  deviceId: string,
  name: string | null,
  currentDeviceId?: string,
): Promise<DeviceDto> {
  const [row] = await deps.db
    .update(devices)
    .set({ name })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .returning();

  if (!row) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
  return toDeviceDto(row, currentDeviceId);
}

/**
 * Revokes one of the caller's devices. Its refresh token stops working and the
 * access tokens bound to it are refused by the auth guard.
 */
export async function revokeDevice(
  deps: AppDeps,
  userId: string,
  deviceId: string,
  now: Date,
): Promise<void> {
  const rows = await deps.db
    .update(devices)
    .set({ revokedAt: now })
    .where(and(eq(devices.id, deviceId), eq(devices.userId, userId)))
    .returning({ id: devices.id });

  if (rows.length === 0) {
    throw new AppError(404, ERROR_CODES.NOT_FOUND);
  }
}
