import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import { createAdmin } from '../src/auth/service';
import { libraries, users } from '../src/db/schema';
import { LIBRARY_ID } from '../src/library/service';
import {
  buildTestApp,
  buildTestDeps,
  createInvite,
  loginAs,
  resetDb,
  seedUser,
  setUserInactive,
  testDb,
} from './helpers';

it('registers with a valid invite and returns a usable access token', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: {
    inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者',
  }});
  expect(res.statusCode).toBe(201);
  const tokens = res.json();
  const me = await app.inject({ method: 'GET', url: '/api/auth/me', headers: { authorization: `Bearer ${tokens.accessToken}` } });
  expect(me.statusCode).toBe(200);
  expect(me.json()).toMatchObject({ username: 'reader', role: 'member' });
});

it('rejects used, expired and unknown invite codes', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  const expired = await createInvite(app, { expiresAt: new Date(Date.now() - 60_000) });
  const first = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'first_user', password: 'a-long-password', displayName: 'A' } });
  expect(first.statusCode).toBe(201);
  for (const inviteCode of [code, expired, 'NOPE00']) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode, username: 'second_user', password: 'a-long-password', displayName: 'U' } });
    expect(res.statusCode).toBe(400);
    expect(res.json().error.code).toBe('INVITE_INVALID');
  }
});

it('rejects a wrong password and a disabled account', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });
  const wrong = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'wrong-password' } });
  expect(wrong.statusCode).toBe(401);
  await setUserInactive(app, 'reader');
  const disabled = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'a-long-password' } });
  expect(disabled.statusCode).toBe(403);
});

it('rotates refresh tokens and revokes on logout', async () => {
  await resetDb();
  const app = await buildTestApp();
  const code = await createInvite(app);
  const reg = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });
  const first = reg.json();
  const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first.refreshToken } });
  expect(refreshed.statusCode).toBe(200);
  const second = refreshed.json();
  expect(second.refreshToken).not.toBe(first.refreshToken);
  const replay = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: first.refreshToken } });
  expect(replay.statusCode).toBe(401);
  await app.inject({ method: 'POST', url: '/api/auth/logout', payload: { refreshToken: second.refreshToken } });
  const afterLogout = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: second.refreshToken } });
  expect(afterLogout.statusCode).toBe(401);
});

it('rate-limits repeated failed logins', async () => {
  await resetDb();
  const app = await buildTestApp({ loginRateLimit: 3 });
  const code = await createInvite(app);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });
  for (let i = 0; i < 3; i += 1) {
    const res = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'wrong-password' } });
    expect(res.statusCode).toBe(401);
  }
  const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: 'reader', password: 'wrong-password' } });
  expect(limited.statusCode).toBe(429);
  expect(limited.json().error.code).toBe('RATE_LIMITED');
});

it('keys login rate limiting on the forwarded client IP when one proxy hop is trusted', async () => {
  await resetDb();
  const app = await buildTestApp({ loginRateLimit: 1, trustProxy: 1 });
  const code = await createInvite(app);
  await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'reader', password: 'a-long-password', displayName: '读者' } });

  const login = (clientIp: string) =>
    app.inject({
      method: 'POST',
      url: '/api/auth/login',
      headers: { 'x-forwarded-for': clientIp },
      payload: { username: 'reader', password: 'wrong-password' },
    });

  expect((await login('203.0.113.9')).statusCode).toBe(401);
  expect((await login('203.0.113.9')).statusCode).toBe(429);
  expect((await login('203.0.113.10')).statusCode).toBe(401);
});

it("does not clear another user's failure counter on refresh", async () => {
  await resetDb();
  const app = await buildTestApp({ loginRateLimit: 2 });
  const alice = await seedUser('member', 'alice');
  const bob = await seedUser('member', 'bob');

  const failed = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: alice.username, password: 'wrong-password' } });
  expect(failed.statusCode).toBe(401);

  const bobTokens = await loginAs(app, bob);
  const refreshed = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: bobTokens.refreshToken } });
  expect(refreshed.statusCode).toBe(200);

  const secondFailure = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: alice.username, password: 'wrong-password' } });
  expect(secondFailure.statusCode).toBe(401);
  const limited = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: alice.username, password: 'wrong-password' } });
  expect(limited.statusCode).toBe(429);

  const secondRefresh = await app.inject({ method: 'POST', url: '/api/auth/refresh', payload: { refreshToken: refreshed.json().refreshToken } });
  expect(secondRefresh.statusCode).toBe(200);
});

describe('createAdmin', () => {
  it('creates the first admin and refuses a second', async () => {
    await resetDb();
    const deps = await buildTestDeps();
    const first = await createAdmin(deps, {
      username: 'admin_one', password: 'a-long-password', displayName: '管理员',
    });
    expect(first.userId).toBeTruthy();

    const [admin] = await testDb.select().from(users).where(eq(users.id, first.userId));
    expect(admin).toMatchObject({ username: 'admin_one', role: 'admin' });
    const [library] = await testDb.select().from(libraries).where(eq(libraries.id, LIBRARY_ID));
    expect(library).toMatchObject({ id: LIBRARY_ID, name: '书房' });

    await expect(
      createAdmin(deps, { username: 'admin_two', password: 'a-long-password', displayName: '管理员' }),
    ).rejects.toMatchObject({ statusCode: 409, code: 'CONFLICT' });
  });
});
