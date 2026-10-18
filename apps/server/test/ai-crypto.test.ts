import { describe, expect, it } from 'vitest';
import { configKeyFor, decryptSecret, deriveConfigKey, encryptSecret } from '../src/ai/crypto';
import { buildTestConfig } from './helpers';

describe('AI config encryption', () => {
  it('round-trips an encrypted secret and rejects tampering', () => {
    const key = deriveConfigKey('a-config-secret-that-is-long-enough-123');
    const secret = encryptSecret('sk-test-123456', key);
    expect(secret.ciphertext).not.toContain('sk-test');
    expect(decryptSecret(secret, key)).toBe('sk-test-123456');
    expect(() => decryptSecret({ ...secret, tag: Buffer.alloc(16).toString('base64') }, key))
      .toThrow('Could not decrypt the AI key');
  });

  it('derives a different key from a different secret', () => {
    const a = deriveConfigKey('a'.repeat(32));
    const b = deriveConfigKey('b'.repeat(32));
    expect(a.equals(b)).toBe(false);
    expect(a).toHaveLength(32);
  });

  it('uses the configured AI secret when present and falls back to the JWT secret', () => {
    const withAiSecret = buildTestConfig({
      ai: { configSecret: 'a-dedicated-ai-config-secret-at-least-32' },
    });
    const withJwtSecret = buildTestConfig({ ai: { configSecret: undefined } });
    expect(configKeyFor(withAiSecret).equals(deriveConfigKey(withAiSecret.ai.configSecret!))).toBe(true);
    expect(configKeyFor(withJwtSecret).equals(deriveConfigKey(withJwtSecret.jwtSecret))).toBe(true);
    expect(configKeyFor(withAiSecret).equals(configKeyFor(withJwtSecret))).toBe(false);
  });

  it('never reuses an IV across encryptions', () => {
    const key = deriveConfigKey('c'.repeat(32));
    const first = encryptSecret('sk-test-123456', key);
    const second = encryptSecret('sk-test-123456', key);
    expect(first.iv).not.toBe(second.iv);
    expect(first.ciphertext).not.toBe(second.ciphertext);
  });
});
