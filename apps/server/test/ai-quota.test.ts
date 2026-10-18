import { expect, it } from 'vitest';
import { periodKeys, readQuota, releaseQuota, reserveQuota, settleQuota } from '../src/ai/quota';
import { resetDb, seedUser, testDb } from './helpers';

const limits = { daily: 100_000, monthly: 1_000_000 };
const now = new Date('2026-10-19T09:00:00.000Z');

it('uses the user timezone for day and month keys', () => {
  const lateUtc = new Date('2026-10-19T17:30:00.000Z');
  expect(periodKeys(lateUtc, 'Asia/Shanghai')).toEqual({ day: '2026-10-20', month: '2026-10' });
  expect(periodKeys(lateUtc, 'UTC')).toEqual({ day: '2026-10-19', month: '2026-10' });
  expect(periodKeys(lateUtc, 'not/a-zone')).toEqual({ day: '2026-10-19', month: '2026-10' });
});

it('reserves, settles and reports the actual usage', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'Asia/Shanghai', estimate: 50_000, limits, now,
  });
  // Reservation alone counts against the window.
  expect(await readQuota(testDb, { userId: user.id, timezone: 'Asia/Shanghai', limits, now }))
    .toMatchObject({ daily: { used: 0, reserved: 50_000, limit: 100_000 } });

  const after = await settleQuota(testDb, reservation, { promptTokens: 10_000, completionTokens: 2_000 }, now);
  expect(after.daily).toEqual({ used: 12_000, reserved: 0, limit: 100_000 });
  expect(after.monthly).toEqual({ used: 12_000, reserved: 0, limit: 1_000_000 });
});

it('serialises concurrent reservations and rejects the one that would exceed the limit', async () => {
  await resetDb();
  const user = await seedUser('member');
  const input = { userId: user.id, timezone: 'Asia/Shanghai', estimate: 60_000, limits, now };

  const results = await Promise.allSettled([
    reserveQuota(testDb, input),
    reserveQuota(testDb, input),
  ]);
  expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
  const rejected = results.find((result) => result.status === 'rejected');
  expect(rejected).toBeDefined();
  if (rejected?.status === 'rejected') {
    expect(rejected.reason).toMatchObject({ statusCode: 429, code: 'AI_QUOTA_EXCEEDED' });
  }

  const quota = await readQuota(testDb, { userId: user.id, timezone: 'Asia/Shanghai', limits, now });
  expect(quota.daily.reserved).toBe(60_000);
  expect(quota.monthly.reserved).toBe(60_000);
});

it('starts a fresh window after the user-local day rolls over', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'Asia/Shanghai', estimate: 1_000, limits, now,
  });
  await settleQuota(testDb, reservation, { promptTokens: 900, completionTokens: 100 }, now);

  const nextDay = new Date('2026-10-20T09:00:00.000Z');
  const quota = await readQuota(testDb, {
    userId: user.id, timezone: 'Asia/Shanghai', limits, now: nextDay,
  });
  expect(quota.daily.used).toBe(0);
  // The month window still carries the usage.
  expect(quota.monthly.used).toBe(1_000);
});

it('starts a fresh window after the user-local month rolls over', async () => {
  await resetDb();
  const user = await seedUser('member');
  const lastOfMonth = new Date('2026-10-31T09:00:00.000Z');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'UTC', estimate: 1_000, limits, now: lastOfMonth,
  });
  await settleQuota(testDb, reservation, { promptTokens: 900, completionTokens: 100 }, lastOfMonth);

  const firstOfMonth = new Date('2026-11-01T09:00:00.000Z');
  const quota = await readQuota(testDb, {
    userId: user.id, timezone: 'UTC', limits, now: firstOfMonth,
  });
  expect(quota.daily.used).toBe(0);
  expect(quota.monthly.used).toBe(0);
});

it('keeps reserved and used non-negative and releases a failed request', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'UTC', estimate: 2_000, limits, now,
  });
  const quota = await releaseQuota(testDb, reservation, now);
  expect(quota.daily).toEqual({ used: 0, reserved: 0, limit: 100_000 });
});

it('rounds the estimate up to at least one token', async () => {
  await resetDb();
  const user = await seedUser('member');
  const reservation = await reserveQuota(testDb, {
    userId: user.id, timezone: 'UTC', estimate: 0.4, limits, now,
  });
  expect(reservation.daily.estimate).toBe(1);
  expect(reservation.monthly.estimate).toBe(1);
});

it('releases reservations left behind by a crashed request', async () => {
  const { reclaimStaleReservations } = await import('../src/ai/quota');
  const user = await seedUser('member');
  const old = new Date('2026-10-19T09:00:00.000Z');
  await reserveQuota(testDb, {
    userId: user.id, timezone: 'UTC', estimate: 5_000, limits, now: old,
  });
  const now = new Date('2026-10-19T11:00:00.000Z');
  expect(await reclaimStaleReservations(testDb, now)).toBeGreaterThan(0);
  const quota = await readQuota(testDb, { userId: user.id, timezone: 'UTC', limits, now });
  expect(quota.daily.reserved).toBe(0);
  expect(quota.monthly.reserved).toBe(0);
});
