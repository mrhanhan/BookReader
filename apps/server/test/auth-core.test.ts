import Fastify from 'fastify';
import { describe, expect, it } from 'vitest';
import { hashPassword, verifyPassword } from '../src/auth/password';
import { makeRequireAdmin, makeRequireAuth } from '../src/auth/guards';
import { hashRefreshToken, newRefreshToken, signAccessToken, verifyAccessToken } from '../src/auth/tokens';
import { buildTestDeps, seedUser } from './helpers';

it('hashes passwords with argon2id and verifies them', async () => {
  const hash = await hashPassword('correct horse battery');
  expect(hash).toMatch(/^\$argon2id\$/);
  expect(hash).not.toContain('correct horse');
  await expect(verifyPassword(hash, 'correct horse battery')).resolves.toBe(true);
  await expect(verifyPassword(hash, 'wrong password')).resolves.toBe(false);
});
it('signs and verifies access tokens, rejecting expired ones', async () => {
  const token = await signAccessToken({ sub: 'user-1', role: 'admin' }, 's'.repeat(32), 900);
  await expect(verifyAccessToken(token, 's'.repeat(32))).resolves.toEqual({ sub: 'user-1', role: 'admin' });
  await expect(verifyAccessToken(token, 'x'.repeat(32))).rejects.toThrow();
  const expired = await signAccessToken({ sub: 'user-1', role: 'member' }, 's'.repeat(32), -1);
  await expect(verifyAccessToken(expired, 's'.repeat(32))).rejects.toThrow(/expired/i);
});
it('creates 30-day refresh tokens stored as sha256 hashes', () => {
  const { token, hash, expiresAt } = newRefreshToken();
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  expect(hash).toHaveLength(64);
  expect(hashRefreshToken(token)).toBe(hash);
  const days = (expiresAt.getTime() - Date.now()) / 86_400_000;
  expect(days).toBeGreaterThan(29.9);
});
it('guards routes: 401 without a token, 403 for a member on an admin route', async () => {
  const deps = await buildTestDeps();
  const app = Fastify();
  app.get('/auth', { preHandler: makeRequireAuth(deps) }, async () => ({ ok: true }));
  app.get('/admin', { preHandler: [makeRequireAuth(deps), makeRequireAdmin()] }, async () => ({ ok: true }));
  expect((await app.inject({ method: 'GET', url: '/auth' })).statusCode).toBe(401);
  const member = await seedUser('member');
  const token = await signAccessToken({ sub: member.id, role: 'member' }, deps.config.jwtSecret, 900);
  expect((await app.inject({ method: 'GET', url: '/auth', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(200);
  expect((await app.inject({ method: 'GET', url: '/admin', headers: { authorization: `Bearer ${token}` } })).statusCode).toBe(403);
});
