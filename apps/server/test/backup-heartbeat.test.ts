import { beforeEach, expect, it } from 'vitest';
import {
  authHeader, createTestApp, resetDb, seedUser, type SeededUser,
} from './helpers';

const NOW = new Date('2026-10-19T04:00:00.000Z');
const VALID = {
  source: 'server-export',
  status: 'success',
  startedAt: '2026-10-19T03:00:00+08:00',
  finishedAt: '2026-10-19T03:10:00+08:00',
  bytes: 2_048,
  diskFreeBytes: 40_000,
  diskTotalBytes: 100_000,
};

let admin: SeededUser;

beforeEach(async () => {
  await resetDb();
  admin = await seedUser('admin');
});

/** createTestApp 返回的 deps 与应用共享同一对象，冻结时钟要直接改 deps.clock。 */
async function frozenApp(overrides = {}) {
  const built = await createTestApp(overrides);
  built.deps.clock = { now: () => NOW };
  return built;
}

it('accepts an admin JWT and exposes the report in the status', async () => {
  const built = await frozenApp();
  const posted = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: await authHeader(admin), payload: VALID });
  expect(posted.statusCode).toBe(201);
  const status = await built.app.inject({ method: 'GET', url: '/api/admin/backup', headers: await authHeader(admin) });
  const body = status.json();
  expect(body.lastSuccessAt).not.toBeNull();
  expect(body.reports[0]).toMatchObject({ source: 'server-export', status: 'success', bytes: 2_048 });
  expect(body.backupStale).toBe(false);
  expect(body.backupPcSilent).toBe(true);
  expect(body.diskLow).toBe(false);
});

it('accepts the backup token and rejects wrong or missing credentials', async () => {
  const built = await frozenApp({ backup: { token: 't'.repeat(32) } });
  const token = 't'.repeat(32);
  const ok = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: { 'x-backup-token': token }, payload: VALID });
  expect(ok.statusCode).toBe(201);
  const wrong = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: { 'x-backup-token': 'x'.repeat(32) }, payload: VALID });
  expect(wrong.statusCode).toBe(401);
  const anonymous = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', payload: VALID });
  expect(anonymous.statusCode).toBe(401);
  const member = await built.app.inject({ method: 'POST', url: '/api/admin/backup/heartbeat', headers: await authHeader(await seedUser('member')), payload: VALID });
  expect(member.statusCode).toBe(403);
});

it('accepts script-style Z timestamps and integer byte fields', async () => {
  // scripts/lib/heartbeat.sh emits `date -u` timestamps (ending in Z) and
  // integer byte counts; keep the script and the schema contract aligned.
  const token = 't'.repeat(32);
  const built = await frozenApp({ backup: { token } });
  const response = await built.app.inject({
    method: 'POST',
    url: '/api/admin/backup/heartbeat',
    headers: { 'x-backup-token': token },
    payload: {
      source: 'server-export',
      status: 'success',
      startedAt: '2026-10-19T03:00:00Z',
      finishedAt: '2026-10-19T03:10:00Z',
      bytes: 0,
      diskFreeBytes: 4_000_000_000,
      diskTotalBytes: 10_000_000_000,
      message: 'C:\\bookr\\backups mirror complete',
    },
  });
  expect(response.statusCode).toBe(201);
});

it('computes staleness, silence and low disk from the clock', async () => {
  const built = await frozenApp();
  // The heartbeat is received two days ago, then the clock jumps back to NOW.
  built.deps.clock = { now: () => new Date(NOW.getTime() - 48 * 3_600_000) };
  await built.app.inject({
    method: 'POST', url: '/api/admin/backup/heartbeat', headers: await authHeader(admin),
    // The run itself finished two days ago; finishedAt must not precede startedAt.
    payload: { ...VALID, source: 'backup-pc', startedAt: '2026-10-17T17:00:00+08:00', finishedAt: '2026-10-17T18:00:00+08:00', diskFreeBytes: 1_000 },
  });
  built.deps.clock = { now: () => NOW };
  const status = (await built.app.inject({ method: 'GET', url: '/api/admin/backup', headers: await authHeader(admin) })).json();
  expect(status.backupStale).toBe(true);
  expect(status.backupPcSilent).toBe(true);
  expect(status.diskLow).toBe(true);
});
