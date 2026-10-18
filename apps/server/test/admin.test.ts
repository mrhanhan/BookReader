import { expect, it } from 'vitest';
import {
  authHeader,
  buildTestApp,
  loginAs,
  resetDb,
  seedBook,
  seedUser,
} from './helpers';

it('rejects every admin route for members', async () => {
  await resetDb();
  const app = await buildTestApp();
  const member = await seedUser('member');
  for (const url of ['/api/admin/members', '/api/admin/invites', '/api/admin/storage']) {
    expect((await app.inject({ method: 'GET', url, headers: await authHeader(member) })).statusCode).toBe(403);
  }
});
it('creates, lists and revokes invites', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const created = await app.inject({ method: 'POST', url: '/api/admin/invites', headers: await authHeader(admin), payload: { expiresInHours: 24 } });
  expect(created.statusCode).toBe(201);
  const code = created.json().code;
  expect((await app.inject({ method: 'GET', url: '/api/admin/invites', headers: await authHeader(admin) })).json().items).toHaveLength(1);
  expect((await app.inject({ method: 'DELETE', url: `/api/admin/invites/${code}`, headers: await authHeader(admin) })).statusCode).toBe(204);
  const register = await app.inject({ method: 'POST', url: '/api/auth/register', payload: { inviteCode: code, username: 'newbie', password: 'a-long-password', displayName: '新人' } });
  expect(register.json().error.code).toBe('INVITE_INVALID');
});
it('disables a member and revokes their sessions', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const tokens = await loginAs(app, member);
  const res = await app.inject({ method: 'PATCH', url: `/api/admin/members/${member.id}`, headers: await authHeader(admin), payload: { isActive: false } });
  expect(res.statusCode).toBe(200);
  const denied = await app.inject({ method: 'GET', url: '/api/books', headers: { authorization: `Bearer ${tokens.accessToken}` } });
  expect(denied.statusCode).toBe(401);
  const login = await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'valid-password-1' } });
  expect(login.statusCode).toBe(403);
});
it('resets a member password and revokes their sessions', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const tokens = await loginAs(app, member);
  const res = await app.inject({ method: 'PATCH', url: `/api/admin/members/${member.id}`, headers: await authHeader(admin), payload: { password: 'brand-new-password' } });
  expect(res.statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/api/books', headers: { authorization: `Bearer ${tokens.accessToken}` } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'valid-password-1' } })).statusCode).toBe(401);
  expect((await app.inject({ method: 'POST', url: '/api/auth/login', payload: { username: member.username, password: 'brand-new-password' } })).statusCode).toBe(200);
});
it('refuses to let an administrator deactivate their own account', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  // A second administrator exists, so the last-admin rule is not what rejects
  // this request; the self-deactivation rule is.
  const backupAdmin = await seedUser('admin');

  const res = await app.inject({
    method: 'PATCH',
    url: `/api/admin/members/${admin.id}`,
    headers: await authHeader(admin),
    payload: { isActive: false },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatchObject({
    code: 'CONFLICT',
    message: 'You cannot deactivate your own account',
  });

  const members = await app.inject({
    method: 'GET',
    url: '/api/admin/members',
    headers: await authHeader(backupAdmin),
  });
  const stored = members.json().items.find((item: { id: string }) => item.id === admin.id);
  expect(stored.isActive).toBe(true);
});
it('refuses to deactivate the last active administrator', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');

  // Deactivating the only remaining administrator is attempted against the
  // caller themselves: any other caller would itself be an active admin.
  const res = await app.inject({
    method: 'PATCH',
    url: `/api/admin/members/${admin.id}`,
    headers: await authHeader(admin),
    payload: { isActive: false },
  });
  expect(res.statusCode).toBe(409);
  expect(res.json().error).toMatchObject({
    code: 'CONFLICT',
    message: 'The last active administrator cannot be deactivated',
  });

  const members = await app.inject({
    method: 'GET',
    url: '/api/admin/members',
    headers: await authHeader(admin),
  });
  const stored = members.json().items.find((item: { id: string }) => item.id === admin.id);
  expect(stored.isActive).toBe(true);
});
it('reports total and per-member storage usage', async () => {
  await resetDb();
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  await seedBook({ uploadedBy: member.id, size: 300 });
  await seedBook({ uploadedBy: admin.id, size: 200 });
  const res = await app.inject({ method: 'GET', url: '/api/admin/storage', headers: await authHeader(admin) });
  expect(res.json()).toMatchObject({ usedBytes: 500 });
  expect(res.json().perMember).toEqual(expect.arrayContaining([expect.objectContaining({ userId: member.id, usedBytes: 300 })]));
});
