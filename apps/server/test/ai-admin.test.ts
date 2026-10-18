import { eq } from 'drizzle-orm';
import { describe, expect, it } from 'vitest';
import {
  AI_CONFIG_ID,
  bootstrapAiConfig,
  normalizeAiBaseUrl,
  normalizeModelName,
  readAiConfig,
  readAiConfigView,
} from '../src/ai/config';
import { aiConfig, auditLogs, users } from '../src/db/schema';
import { authHeader, buildTestDeps, createTestApp, resetDb, seedUser, testDb } from './helpers';

describe('AI base URL and model normalization', () => {
  it('accepts https and loopback http endpoints', () => {
    expect(normalizeAiBaseUrl('https://api.deepseek.com/v1/')).toBe('https://api.deepseek.com/v1');
    expect(normalizeAiBaseUrl('http://localhost:9000/v1')).toBe('http://localhost:9000/v1');
    expect(normalizeAiBaseUrl('http://127.0.0.1:9000')).toBe('http://127.0.0.1:9000');
    expect(normalizeAiBaseUrl('http://[::1]:9000/v1')).toBe('http://[::1]:9000/v1');
    expect(normalizeAiBaseUrl('http://host.docker.internal:11434/v1')).toBe(
      'http://host.docker.internal:11434/v1',
    );
  });

  it('rejects plaintext remote endpoints, credentials, queries and fragments', () => {
    for (const url of [
      'http://evil.example.com/v1',
      'ftp://api.deepseek.com/v1',
      'https://user:pass@api.deepseek.com/v1',
      'https://user@api.deepseek.com/v1',
      'https://api.deepseek.com/v1?key=1',
      'https://api.deepseek.com/v1#frag',
      'not a url',
      '',
    ]) {
      expect(() => normalizeAiBaseUrl(url)).toThrow('Invalid AI base URL');
    }
  });

  it('trims model names and rejects blanks, control characters and overlong names', () => {
    expect(normalizeModelName('  deepseek-chat  ')).toBe('deepseek-chat');
    for (const model of ['', '   ', 'deep seek', 'deep\tseek', 'a'.repeat(65)]) {
      expect(() => normalizeModelName(model)).toThrow('Invalid AI model name');
    }
  });
});

it('never returns the API key from the admin API and audits changes', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const admin = await seedUser('admin');
  const headers = await authHeader(admin);
  const secret = 'sk-live-secret-value-123';

  const saved = await app.inject({
    method: 'PUT', url: '/api/admin/ai', headers,
    payload: { apiKey: secret, chatModel: 'deepseek-chat' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.body).not.toContain(secret);

  const view = await app.inject({ method: 'GET', url: '/api/admin/ai', headers });
  expect(view.json()).toMatchObject({ configured: true, hasApiKey: true, chatModel: 'deepseek-chat' });
  expect(view.body).not.toContain(secret);

  const cleared = await app.inject({ method: 'DELETE', url: '/api/admin/ai', headers });
  expect(cleared.statusCode).toBe(204);
  const after = await app.inject({ method: 'GET', url: '/api/admin/ai', headers });
  expect(after.json()).toMatchObject({ configured: false });

  const entries = await testDb.select().from(auditLogs);
  const actions = entries.map((entry) => entry.action);
  expect(actions).toContain('ai.config.update');
  expect(actions).toContain('ai.config.delete');
  expect(JSON.stringify(entries)).not.toContain(secret);
});

it('keeps the stored key when other fields change', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const admin = await seedUser('admin');
  const headers = await authHeader(admin);

  const saved = await app.inject({
    method: 'PUT', url: '/api/admin/ai', headers,
    payload: { apiKey: 'sk-live-secret-value-123' },
  });
  expect(saved.statusCode).toBe(200);
  const updated = await app.inject({
    method: 'PUT', url: '/api/admin/ai', headers,
    payload: { reasonerModel: 'deepseek-reasoner' },
  });
  expect(updated.statusCode).toBe(200);
  expect(updated.json()).toMatchObject({ hasApiKey: true, reasonerModel: 'deepseek-reasoner' });
});

it('requires a key on the first write', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const admin = await seedUser('admin');
  const response = await app.inject({
    method: 'PUT',
    url: '/api/admin/ai',
    headers: await authHeader(admin),
    payload: { chatModel: 'deepseek-chat' },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.details).toEqual({ field: 'apiKey' });
});

it('lets an administrator adjust a member AI quota and switch', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const admin = await seedUser('admin');
  const member = await seedUser('member');
  const headers = await authHeader(admin);
  const patched = await app.inject({
    method: 'PATCH',
    url: `/api/admin/members/${member.id}`,
    headers,
    payload: { aiEnabled: false, aiDailyTokenLimit: 500, aiMonthlyTokenLimit: 5000 },
  });
  expect(patched.statusCode).toBe(200);
  expect(patched.json()).toMatchObject({
    aiEnabled: false, aiDailyTokenLimit: 500, aiMonthlyTokenLimit: 5000,
  });

  const [row] = await testDb
    .select({
      aiEnabled: users.aiEnabled,
      daily: users.aiDailyTokenLimit,
      monthly: users.aiMonthlyTokenLimit,
    })
    .from(users)
    .where(eq(users.id, member.id));
  expect(row).toEqual({ aiEnabled: false, daily: 500, monthly: 5000 });

  const entries = await testDb.select().from(auditLogs);
  const update = entries.find((entry) => entry.action === 'admin.member.update');
  expect(update?.metadata).toEqual({
    aiEnabled: false,
    aiDailyTokenLimit: 500,
    aiMonthlyTokenLimit: 5000,
  });
});

it('rejects non-admin config access and unsafe base URLs', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const member = await seedUser('member');
  expect((await app.inject({ method: 'GET', url: '/api/admin/ai', headers: await authHeader(member) })).statusCode)
    .toBe(403);

  const admin = await seedUser('admin');
  const response = await app.inject({
    method: 'PUT',
    url: '/api/admin/ai',
    headers: await authHeader(admin),
    payload: { apiKey: 'sk-12345678', baseUrl: 'http://evil.example.com/v1' },
  });
  expect(response.statusCode).toBe(400);
});

it('refuses to update a config whose stored key cannot be decrypted', async () => {
  await resetDb();
  const { app } = await createTestApp();
  const admin = await seedUser('admin');
  const headers = await authHeader(admin);

  const saved = await app.inject({
    method: 'PUT', url: '/api/admin/ai', headers,
    payload: { apiKey: 'sk-live-secret-value-123' },
  });
  expect(saved.statusCode).toBe(200);

  // Simulates a JWT_SECRET rotation: the ciphertext is intact but the tag no
  // longer authenticates against the derived key.
  await testDb
    .update(aiConfig)
    .set({ apiKeyTag: Buffer.alloc(16).toString('base64') })
    .where(eq(aiConfig.id, AI_CONFIG_ID));

  const response = await app.inject({
    method: 'PUT',
    url: '/api/admin/ai',
    headers,
    payload: { chatModel: 'deepseek-chat' },
  });
  expect(response.statusCode).toBe(400);
  expect(response.json().error.details).toEqual({ field: 'apiKey' });
});

it('serves a built-in fake provider without touching the database', async () => {
  await resetDb();
  const { app, deps } = await createTestApp({ ai: { fakeProvider: true } });

  expect(await readAiConfig(deps)).toEqual({
    baseUrl: 'https://api.deepseek.com/v1',
    chatModel: 'deepseek-chat',
    reasonerModel: 'deepseek-reasoner',
    apiKey: '',
    fakeProvider: true,
  });
  expect(await readAiConfigView(deps)).toMatchObject({
    configured: true,
    fakeProvider: true,
    hasApiKey: false,
    updatedAt: null,
  });

  const admin = await seedUser('admin');
  const saved = await app.inject({
    method: 'PUT',
    url: '/api/admin/ai',
    headers: await authHeader(admin),
    payload: { apiKey: 'sk-live-secret-value-123' },
  });
  expect(saved.statusCode).toBe(200);
  expect(saved.json()).toMatchObject({ fakeProvider: true, configured: true });
  expect(await testDb.select().from(aiConfig)).toHaveLength(0);
});

it('bootstraps the provider once from the environment and audits it', async () => {
  await resetDb();
  const deps = await buildTestDeps({
    ai: {
      bootstrap: {
        apiKey: 'sk-bootstrap-secret-123',
        baseUrl: 'https://api.example.com/v1',
        chatModel: 'chat-model',
        reasonerModel: 'reasoner-model',
      },
    },
  });

  expect(await bootstrapAiConfig(deps)).toBe('created');
  expect(await bootstrapAiConfig(deps)).toBe('skipped');

  expect(await readAiConfig(deps)).toEqual({
    baseUrl: 'https://api.example.com/v1',
    chatModel: 'chat-model',
    reasonerModel: 'reasoner-model',
    apiKey: 'sk-bootstrap-secret-123',
    fakeProvider: false,
  });
  const rows = await testDb.select().from(aiConfig);
  expect(rows).toHaveLength(1);

  const entries = await testDb.select().from(auditLogs);
  const bootstrapEntry = entries.find((entry) => entry.action === 'ai.config.bootstrap');
  expect(bootstrapEntry?.metadata).toEqual({
    baseUrl: 'https://api.example.com/v1',
    chatModel: 'chat-model',
    reasonerModel: 'reasoner-model',
  });
  expect(JSON.stringify(entries)).not.toContain('sk-bootstrap-secret-123');
});
