import { beforeEach, expect, it } from 'vitest';
import { auditLogs } from '../src/db/schema';
import { authHeader, buildTestApp, resetDb, seedUser, testDb } from './helpers';

beforeEach(async () => {
  await resetDb();
});

it('lists newest first with a joined member name and pagination total', async () => {
  const app = await buildTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const base = Date.parse('2026-10-19T00:00:00.000Z');
  for (let index = 0; index < 25; index += 1) {
    await testDb.insert(auditLogs).values({
      userId: member.id,
      action: 'book.delete',
      target: `book-${index}`,
      createdAt: new Date(base + index * 1_000),
    });
  }
  await testDb.insert(auditLogs).values({ userId: null, action: 'auth.login', target: null });

  const first = await app.inject({ method: 'GET', url: '/api/admin/audit?page=1&pageSize=20', headers: await authHeader(admin) });
  expect(first.statusCode).toBe(200);
  const page = first.json();
  expect(page).toMatchObject({ page: 1, pageSize: 20, total: 26 });
  expect(page.items).toHaveLength(20);
  expect(page.items[0]?.action).toBe('auth.login');
  expect(page.items[1]).toMatchObject({ displayName: member.username, action: 'book.delete' });
  const second = await app.inject({ method: 'GET', url: '/api/admin/audit?page=2&pageSize=20', headers: await authHeader(admin) });
  expect(second.json().items).toHaveLength(6);
});

it('rejects members and invalid pagination', async () => {
  const app = await buildTestApp();
  const member = await seedUser('member');
  expect((await app.inject({ method: 'GET', url: '/api/admin/audit', headers: await authHeader(member) })).statusCode).toBe(403);
  const admin = await seedUser('admin');
  expect((await app.inject({ method: 'GET', url: '/api/admin/audit?pageSize=101', headers: await authHeader(admin) })).statusCode).toBe(400);
});
