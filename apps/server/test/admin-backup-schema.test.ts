import { newId } from '@bookr/shared';
import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import {
  alertEvents, backupReports, monitorStates, systemSettings,
} from '../src/db/schema';
import { resetDb, testDb } from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');

beforeEach(async () => {
  await resetDb();
});

it('system settings default to open registration and Shanghai', async () => {
  await testDb.insert(systemSettings).values({ id: 'global' });
  const [row] = await testDb.select().from(systemSettings).where(eq(systemSettings.id, 'global'));
  expect(row).toMatchObject({ registrationEnabled: true, defaultTimezone: 'Asia/Shanghai' });
});

it('stores backup reports with nullable capacity and a received timestamp', async () => {
  const id = newId();
  await testDb.insert(backupReports).values({
    id,
    source: 'server-export',
    status: 'success',
    startedAt: NOW,
    finishedAt: NOW,
    bytes: 1024,
    diskFreeBytes: 500,
    diskTotalBytes: 1000,
  });
  const [row] = await testDb.select().from(backupReports).where(eq(backupReports.id, id));
  expect(row).toMatchObject({ source: 'server-export', status: 'success', bytes: 1024 });
  expect(row?.receivedAt).toBeInstanceOf(Date);
});

it('tracks monitor state and alert deliveries', async () => {
  await testDb.insert(monitorStates).values({ key: 'backup-stale', active: true, lastAlertAt: NOW });
  await testDb.insert(alertEvents).values({
    id: newId(), key: 'backup-stale', severity: 'critical',
    message: '备份 24 小时未成功', status: 'failed', error: 'ECONNREFUSED',
  });
  const [state] = await testDb.select().from(monitorStates);
  const [event] = await testDb.select().from(alertEvents);
  expect(state).toMatchObject({ key: 'backup-stale', active: true });
  expect(event).toMatchObject({ status: 'failed', error: 'ECONNREFUSED' });
});
