import { beforeEach, expect, it } from 'vitest';
import { createTestApp, resetDb } from './helpers';

beforeEach(async () => {
  await resetDb();
});

it('reports ready with a reachable database and storage', async () => {
  const built = await createTestApp();
  const response = await built.app.inject({ method: 'GET', url: '/readyz' });
  expect(response.statusCode).toBe(200);
  expect(response.json()).toEqual({ status: 'ok', checks: { database: 'ok', storage: 'ok' } });
});

it('reports degraded when storage fails, without leaking details', async () => {
  const built = await createTestApp();
  // FakeStorage 是测试进程共享的单例，不能改它的方法；用原型链包一层只覆盖 head。
  built.deps.storage = Object.create(built.deps.storage, {
    head: { value: async () => { throw new Error('secret endpoint http://minio:9000'); } },
  });
  const response = await built.app.inject({ method: 'GET', url: '/readyz' });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'degraded', checks: { database: 'ok', storage: 'error' } });
  expect(response.body).not.toContain('minio');
});

it('reports degraded when the database probe fails, without leaking details', async () => {
  const built = await createTestApp();
  // 共享 testDb 不能改；只给这次请求换一个会失败的连接池。
  const pool = built.deps.db.$client;
  built.deps.db = new Proxy(built.deps.db, {
    get(target, property, receiver) {
      if (property === '$client') {
        return {
          query: async () => { throw new Error('connect ECONNREFUSED postgres://bookr:secret@db'); },
        } as unknown as typeof pool;
      }
      return Reflect.get(target, property, receiver);
    },
  });
  const response = await built.app.inject({ method: 'GET', url: '/readyz' });
  expect(response.statusCode).toBe(503);
  expect(response.json()).toEqual({ status: 'degraded', checks: { database: 'error', storage: 'ok' } });
  expect(response.body).not.toContain('postgres');
});
