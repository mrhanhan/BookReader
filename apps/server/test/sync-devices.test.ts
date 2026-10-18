import { randomUUID } from 'node:crypto';
import { eq } from 'drizzle-orm';
import { expect, it } from 'vitest';
import { devices } from '../src/db/schema';
import { authHeader, buildTestApp, resetDb, seedUser, testDb } from './helpers';

async function addDevice(userId: string, name: string): Promise<{ id: string }> {
  const [row] = await testDb
    .insert(devices)
    .values({
      userId,
      name,
      platform: 'web',
      refreshTokenHash: `hash-${randomUUID()}`,
      refreshExpiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
      lastSeenAt: new Date(),
    })
    .returning({ id: devices.id });
  if (!row) {
    throw new Error('addDevice could not insert a device');
  }
  return row;
}

it("lists only the caller's devices and marks the current one", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const second = await addDevice(alice.id, '平板');
  const bobDevice = await addDevice(bob.id, 'B 的设备');

  const response = await app.inject({
    method: 'GET',
    url: '/api/devices',
    headers: await authHeader(alice),
  });
  expect(response.statusCode).toBe(200);

  const items = response.json().items as Array<{
    id: string;
    name: string | null;
    platform: string | null;
    current: boolean;
    createdAt: string;
    lastSeenAt: string | null;
  }>;
  expect(items).toHaveLength(2);
  expect(items.find((item) => item.id === alice.deviceId)).toMatchObject({
    current: true,
    name: null,
  });
  expect(items.find((item) => item.id === second.id)).toMatchObject({
    current: false,
    name: '平板',
    platform: 'web',
  });
  expect(items.some((item) => item.id === bobDevice.id)).toBe(false);
  expect(items.every((item) => typeof item.createdAt === 'string')).toBe(true);
  expect(items.every((item) => item.lastSeenAt === null || typeof item.lastSeenAt === 'string')).toBe(
    true,
  );
});

it('renames and revokes a device', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const second = await addDevice(alice.id, '旧名字');
  const headers = await authHeader(alice);

  const renamed = await app.inject({
    method: 'PATCH',
    url: `/api/devices/${second.id}`,
    headers,
    payload: { name: '  新名字  ' },
  });
  expect(renamed.statusCode).toBe(200);
  expect(renamed.json().device).toMatchObject({
    id: second.id,
    name: '新名字',
    current: false,
  });

  const current = await app.inject({
    method: 'PATCH',
    url: `/api/devices/${alice.deviceId}`,
    headers,
    payload: { name: '手机' },
  });
  expect(current.json().device).toMatchObject({ id: alice.deviceId, current: true });

  const cleared = await app.inject({
    method: 'PATCH',
    url: `/api/devices/${second.id}`,
    headers,
    payload: { name: null },
  });
  expect(cleared.json().device.name).toBeNull();

  const blank = await app.inject({
    method: 'PATCH',
    url: `/api/devices/${second.id}`,
    headers,
    payload: { name: '   ' },
  });
  expect(blank.statusCode).toBe(400);

  const tooLong = await app.inject({
    method: 'PATCH',
    url: `/api/devices/${second.id}`,
    headers,
    payload: { name: 'x'.repeat(61) },
  });
  expect(tooLong.statusCode).toBe(400);

  const revoked = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${second.id}`,
    headers,
  });
  expect(revoked.statusCode).toBe(204);

  const [row] = await testDb.select().from(devices).where(eq(devices.id, second.id));
  expect(row?.revokedAt).toBeInstanceOf(Date);

  const list = await app.inject({ method: 'GET', url: '/api/devices', headers });
  expect(
    (list.json().items as Array<{ id: string }>).map((item) => item.id),
  ).not.toContain(second.id);
});

it("404s for another user's device", async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');
  const headers = await authHeader(alice);

  const patch = await app.inject({
    method: 'PATCH',
    url: `/api/devices/${bob.deviceId}`,
    headers,
    payload: { name: '偷改' },
  });
  expect(patch.statusCode).toBe(404);

  const remove = await app.inject({
    method: 'DELETE',
    url: `/api/devices/${bob.deviceId}`,
    headers,
  });
  expect(remove.statusCode).toBe(404);

  const [row] = await testDb.select().from(devices).where(eq(devices.id, bob.deviceId));
  expect(row).toMatchObject({ name: null, revokedAt: null });
});

it('rejects device requests without a token', async () => {
  await resetDb();
  const app = await buildTestApp();
  const alice = await seedUser('member', 'alice');

  expect((await app.inject({ method: 'GET', url: '/api/devices' })).statusCode).toBe(401);
  expect(
    (
      await app.inject({
        method: 'PATCH',
        url: `/api/devices/${alice.deviceId}`,
        payload: { name: 'x' },
      })
    ).statusCode,
  ).toBe(401);
  expect(
    (await app.inject({ method: 'DELETE', url: `/api/devices/${alice.deviceId}` })).statusCode,
  ).toBe(401);
});
