import { eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { auditLogs, invites, users } from '../src/db/schema';
import { authHeader, buildTestApp, resetDb, seedUser, testDb, type SeededUser } from './helpers';

let app: FastifyInstance;
let admin: SeededUser;

beforeEach(async () => {
  await resetDb();
  app = await buildTestApp();
  admin = await seedUser('admin');
});

it('returns defaults before anything is stored', async () => {
  const response = await app.inject({ method: 'GET', url: '/api/admin/settings', headers: await authHeader(admin) });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({
    registrationEnabled: true,
    defaultTimezone: 'Asia/Shanghai',
    updatedAt: null,
  });
});

it('patches, persists and audits one setting', async () => {
  const response = await app.inject({
    method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin),
    payload: { registrationEnabled: false, defaultTimezone: ' Europe/Berlin ' },
  });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toMatchObject({ registrationEnabled: false, defaultTimezone: 'Europe/Berlin' });
  const audit = await testDb.select().from(auditLogs).where(eq(auditLogs.action, 'admin.settings.update'));
  expect(audit).toHaveLength(1);
  expect(audit[0]?.metadata).toEqual({ changes: { registrationEnabled: false, defaultTimezone: 'Europe/Berlin' } });
});

it('rejects invalid input and members', async () => {
  const member = await seedUser('member');
  for (const payload of [{}, { defaultTimezone: 'Mars/Olympus' }, { registration: false }]) {
    const response = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin), payload });
    expect(response.statusCode, JSON.stringify(payload)).toBe(400);
  }
  const denied = await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(member), payload: { registrationEnabled: false } });
  expect(denied.statusCode).toBe(403);
});

it('blocks registration while disabled and applies the default timezone when enabled', async () => {
  await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin), payload: { registrationEnabled: false } });
  await testDb.insert(invites).values({
    code: 'ABCDEFGHJK', createdBy: admin.id, expiresAt: new Date(Date.now() + 3_600_000),
  });
  const blocked = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { inviteCode: 'ABCDEFGHJK', username: 'blocked', password: 'a-long-password', displayName: '被拒' },
  });
  expect(blocked.statusCode).toBe(403);
  expect((await testDb.select().from(users)).some((row) => row.username === 'blocked')).toBe(false);

  await app.inject({ method: 'PATCH', url: '/api/admin/settings', headers: await authHeader(admin), payload: { registrationEnabled: true, defaultTimezone: 'America/New_York' } });
  const created = await app.inject({
    method: 'POST', url: '/api/auth/register',
    payload: { inviteCode: 'ABCDEFGHJK', username: 'newbie', password: 'a-long-password', displayName: '新人' },
  });
  expect(created.statusCode).toBe(201);
  const [row] = await testDb.select().from(users).where(eq(users.username, 'newbie'));
  expect(row?.timezone).toBe('America/New_York');
});
