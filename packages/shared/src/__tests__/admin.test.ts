import { describe, expect, it } from 'vitest';
import {
  BACKUP_STALE_HOURS,
  backupHeartbeatSchema,
  updateSystemSettingsSchema,
} from '../admin';

describe('updateSystemSettingsSchema', () => {
  it('接受单个字段并去除时区空白', () => {
    expect(updateSystemSettingsSchema.parse({ defaultTimezone: ' America/New_York ' }))
      .toEqual({ defaultTimezone: 'America/New_York' });
    expect(updateSystemSettingsSchema.parse({ registrationEnabled: false }))
      .toEqual({ registrationEnabled: false });
  });
  it('拒绝空对象、未知字段与非法时区', () => {
    expect(updateSystemSettingsSchema.safeParse({}).success).toBe(false);
    expect(updateSystemSettingsSchema.safeParse({ registration: false }).success).toBe(false);
    for (const defaultTimezone of ['', '   ', 'Mars/Olympus', 'x'.repeat(65)]) {
      expect(updateSystemSettingsSchema.safeParse({ defaultTimezone }).success).toBe(false);
    }
  });
});

describe('backupHeartbeatSchema', () => {
  const base = {
    source: 'server-export',
    status: 'success',
    startedAt: '2026-10-19T03:15:00+08:00',
    finishedAt: '2026-10-19T03:21:00+08:00',
  };
  it('接受带偏移的时间与可选容量字段', () => {
    expect(backupHeartbeatSchema.parse({
      ...base,
      bytes: 1024,
      diskFreeBytes: 500,
      diskTotalBytes: 1000,
      message: ' ok ',
    })).toMatchObject({ bytes: 1024, message: 'ok' });
  });
  it('拒绝倒序时间、负数与空闲大于总量', () => {
    expect(backupHeartbeatSchema.safeParse({
      ...base,
      startedAt: '2026-10-19T04:00:00+08:00',
      finishedAt: '2026-10-19T03:00:00+08:00',
    }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({ ...base, bytes: -1 }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({
      ...base,
      diskFreeBytes: 2,
      diskTotalBytes: 1,
    }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({ ...base, source: 'usb' }).success).toBe(false);
    expect(backupHeartbeatSchema.safeParse({ ...base, status: 'partial' }).success).toBe(false);
  });
  it('要求带时区偏移', () => {
    expect(backupHeartbeatSchema.safeParse({
      ...base,
      startedAt: '2026-10-19T03:15:00',
      finishedAt: '2026-10-19T03:21:00',
    }).success).toBe(false);
  });
  it('24 小时是固定的过期阈值', () => {
    expect(BACKUP_STALE_HOURS).toBe(24);
  });
});
