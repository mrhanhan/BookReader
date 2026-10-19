import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { eq } from 'drizzle-orm';
import { alertEvents, monitorStates } from '../src/db/schema';
import { runMonitorTick } from '../src/monitor/check';
import { recordBackupReport } from '../src/backup/service';
import { createTestApp, resetDb, testDb } from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');
const webhook = 'http://alerts.example/hook';

beforeEach(async () => {
  await resetDb();
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** 只统计 backup-stale 的投递，同轮还会发 backup-pc-silent。 */
function staleCalls(fetch: ReturnType<typeof vi.fn>): number {
  return keyCalls(fetch, 'backup-stale');
}

function keyCalls(fetch: ReturnType<typeof vi.fn>, key: string): number {
  return fetch.mock.calls.filter(([, init]) =>
    String((init as RequestInit | undefined)?.body ?? '').includes(`"key":"${key}"`),
  ).length;
}

/** Parses the JSON body of the first delivery attempt for one condition. */
function bodyFor(fetch: ReturnType<typeof vi.fn>, key: string): unknown {
  const call = fetch.mock.calls.find(([, init]) =>
    String((init as RequestInit | undefined)?.body ?? '').includes(`"key":"${key}"`),
  );
  return JSON.parse(String((call?.[1] as RequestInit | undefined)?.body));
}

async function frozenApp(alerts: { webhookUrl?: string | null } = {}) {
  const built = await createTestApp({ alerts });
  built.deps.clock = { now: () => NOW };
  return built;
}

it('sends one alert per continuous incident and re-arms after recovery', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  const built = await frozenApp({ webhookUrl: webhook });

  const first = await runMonitorTick(built.deps, NOW);
  expect(first.map((item) => item.key)).toContain('backup-stale');
  expect(staleCalls(fetch)).toBe(1);
  expect(bodyFor(fetch, 'backup-stale')).toEqual({
    source: 'bookr',
    key: 'backup-stale',
    severity: 'critical',
    message: '尚无成功的备份记录',
    at: NOW.toISOString(),
  });

  const second = await runMonitorTick(built.deps, NOW);
  expect(second.map((item) => item.key)).toContain('backup-stale');
  expect(staleCalls(fetch)).toBe(1);

  await recordBackupReport(built.deps, {
    source: 'server-export', status: 'success',
    startedAt: '2026-10-19T03:50:00+08:00', finishedAt: '2026-10-19T04:00:00+08:00',
    diskFreeBytes: 50_000, diskTotalBytes: 100_000,
  });
  // 恢复后的第一轮必须晚于上一轮告警：同一瞬间的 tick 不能清掉刚设置的窗口。
  await runMonitorTick(built.deps, new Date(NOW.getTime() + 1));
  const states = await testDb.select().from(monitorStates).where(eq(monitorStates.key, 'backup-stale'));
  expect(states[0]?.active).toBe(false);

  // 恢复后 30 小时再次过期，应重新告警。
  const later = new Date(NOW.getTime() + 30 * 3_600_000);
  await runMonitorTick(built.deps, later);
  expect(staleCalls(fetch)).toBeGreaterThanOrEqual(2);
});

it('records a failed delivery and retries on the next tick', async () => {
  const fetch = vi.fn(async () => new Response('', { status: 503 }));
  vi.stubGlobal('fetch', fetch);
  const built = await frozenApp({ webhookUrl: webhook });

  await runMonitorTick(built.deps, NOW);
  const failed = await testDb.select().from(alertEvents);
  expect(failed.some((event) => event.status === 'failed')).toBe(true);
  expect(failed.find((event) => event.key === 'backup-stale')).toMatchObject({
    status: 'failed',
    error: 'WebhookHttpError:503',
  });
  const state = (await testDb.select().from(monitorStates).where(eq(monitorStates.key, 'backup-stale')))[0];
  expect(state?.active).toBe(false);

  const fetchOk = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetchOk);
  await runMonitorTick(built.deps, NOW);
  expect(fetchOk).toHaveBeenCalled();
});

it('keeps state without webhook and never writes alert rows', async () => {
  const built = await frozenApp();
  const conditions = await runMonitorTick(built.deps, NOW);
  expect(conditions.map((item) => item.key)).toContain('backup-stale');
  expect(await testDb.select().from(alertEvents)).toHaveLength(0);
});

it('alerts immediately for a failed heartbeat and the next tick stays quiet', async () => {
  const fetch = vi.fn(async () => new Response(null, { status: 204 }));
  vi.stubGlobal('fetch', fetch);
  const built = await frozenApp({ webhookUrl: webhook });

  await recordBackupReport(built.deps, {
    source: 'server-export', status: 'failure',
    startedAt: '2026-10-19T03:50:00+08:00', finishedAt: '2026-10-19T04:00:00+08:00',
    message: 'rsync exited 23',
  });

  await vi.waitFor(() => {
    expect(keyCalls(fetch, 'backup-failure')).toBe(1);
  });
  expect(bodyFor(fetch, 'backup-failure')).toMatchObject({
    source: 'bookr',
    key: 'backup-failure',
    severity: 'critical',
    message: expect.stringContaining('server-export'),
    at: NOW.toISOString(),
  });

  // The monitor observes the same failure; the shared state machine dedupes it.
  await runMonitorTick(built.deps, NOW);
  expect(keyCalls(fetch, 'backup-failure')).toBe(1);
});
