import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://bookr:bookr@localhost:5432/bookr',
  S3_ENDPOINT: 'http://localhost:9000',
  S3_ACCESS_KEY: 'bookr',
  S3_SECRET_KEY: 'bookr-secret-key',
  JWT_SECRET: 's'.repeat(32),
};

describe('loadConfig S3 credentials', () => {
  it('requires access and secret keys', () => {
    const { S3_ACCESS_KEY: _access, ...withoutAccess } = BASE_ENV;
    expect(() => loadConfig(withoutAccess)).toThrow(/S3_ACCESS_KEY is required/);
    const { S3_SECRET_KEY: _secret, ...withoutSecret } = BASE_ENV;
    expect(() => loadConfig(withoutSecret)).toThrow(/S3_SECRET_KEY is required/);
  });
});

describe('loadConfig S3 public endpoint', () => {
  it('defaults presigned URLs to the internal endpoint', () => {
    expect(loadConfig(BASE_ENV).s3.publicEndpoint).toBe('http://localhost:9000');
  });

  it('accepts a browser-reachable endpoint for presigned URLs', () => {
    const config = loadConfig({ ...BASE_ENV, S3_PUBLIC_ENDPOINT: 'http://localhost:9200' });
    expect(config.s3.publicEndpoint).toBe('http://localhost:9200');
    expect(config.s3.endpoint).toBe('http://localhost:9000');
  });
});

describe('loadConfig TRUST_PROXY', () => {
  it('defaults to false', () => {
    expect(loadConfig(BASE_ENV).trustProxy).toBe(false);
  });

  it('maps true to a single trusted hop', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'true' }).trustProxy).toBe(1);
  });

  it('parses false and zero as disabled', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: '0' }).trustProxy).toBe(false);
  });

  it('parses a positive hop count', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: '1' }).trustProxy).toBe(1);
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: '2' }).trustProxy).toBe(2);
  });

  it('rejects words, negative and fractional values', () => {
    for (const value of ['yes', '-1', '1.5']) {
      expect(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: value })).toThrow(/TRUST_PROXY/);
    }
  });
});

describe('loadConfig CORS allowlist', () => {
  it('parses a comma-separated CORS allowlist', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://x', S3_ENDPOINT: 'http://x', S3_ACCESS_KEY: 'a',
      S3_SECRET_KEY: 'b', JWT_SECRET: 'x'.repeat(32),
      CORS_ORIGIN: ' http://localhost:8180 , https://tauri.localhost ',
    });
    expect(config.corsOrigins).toEqual(['http://localhost:8180', 'https://tauri.localhost']);
  });

  it('defaults to the web and native app origins', () => {
    expect(loadConfig(BASE_ENV).corsOrigins).toEqual([
      'http://localhost:8180',
      'https://tauri.localhost',
      'http://tauri.localhost',
      'https://localhost',
      'capacitor://localhost',
    ]);
  });

  it('rejects an allowlist with no origins', () => {
    expect(() => loadConfig({ ...BASE_ENV, CORS_ORIGIN: ' , ,, ' })).toThrow(/CORS_ORIGIN/);
  });
});

describe('loadConfig AI companion', () => {
  it('defaults to no provider configuration', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.ai).toEqual({
      fakeProvider: false,
      contextTokenBudget: 8000,
      requestTimeoutMs: 60000,
      bootstrap: null,
    });
    expect(config.ai.configSecret).toBeUndefined();
  });

  it('accepts a dedicated config secret of at least 32 characters', () => {
    const config = loadConfig({ ...BASE_ENV, AI_CONFIG_SECRET: 'a'.repeat(32) });
    expect(config.ai.configSecret).toBe('a'.repeat(32));
    expect(() => loadConfig({ ...BASE_ENV, AI_CONFIG_SECRET: 'too-short' })).toThrow(
      /AI_CONFIG_SECRET must be at least 32 characters/,
    );
  });

  it('treats an empty optional secret as unset', () => {
    expect(loadConfig({ ...BASE_ENV, AI_CONFIG_SECRET: '' }).ai.configSecret).toBeUndefined();
  });

  it('parses the fake provider flag', () => {
    for (const value of ['1', 'true']) {
      expect(loadConfig({ ...BASE_ENV, AI_FAKE_PROVIDER: value }).ai.fakeProvider).toBe(true);
    }
    for (const value of ['0', 'false']) {
      expect(loadConfig({ ...BASE_ENV, AI_FAKE_PROVIDER: value }).ai.fakeProvider).toBe(false);
    }
    expect(() => loadConfig({ ...BASE_ENV, AI_FAKE_PROVIDER: 'yes' })).toThrow(/AI_FAKE_PROVIDER/);
  });

  it('builds the bootstrap provider from environment defaults', () => {
    const config = loadConfig({ ...BASE_ENV, AI_API_KEY: 'sk-bootstrap-key' });
    expect(config.ai.bootstrap).toEqual({
      apiKey: 'sk-bootstrap-key',
      baseUrl: 'https://api.deepseek.com/v1',
      chatModel: 'deepseek-chat',
      reasonerModel: 'deepseek-reasoner',
    });
  });

  it('accepts custom bootstrap provider values', () => {
    const config = loadConfig({
      ...BASE_ENV,
      AI_API_KEY: 'sk-bootstrap-key',
      AI_BASE_URL: 'http://localhost:11434/v1',
      AI_CHAT_MODEL: 'qwen-chat',
      AI_REASONER_MODEL: 'qwen-reasoner',
    });
    expect(config.ai.bootstrap).toEqual({
      apiKey: 'sk-bootstrap-key',
      baseUrl: 'http://localhost:11434/v1',
      chatModel: 'qwen-chat',
      reasonerModel: 'qwen-reasoner',
    });
  });

  it('does not bootstrap without an API key', () => {
    expect(loadConfig({ ...BASE_ENV, AI_API_KEY: '' }).ai.bootstrap).toBeNull();
  });

  it('validates the context budget and request timeout ranges', () => {
    expect(loadConfig({ ...BASE_ENV, AI_CONTEXT_TOKEN_BUDGET: '1000' }).ai.contextTokenBudget).toBe(1000);
    expect(loadConfig({ ...BASE_ENV, AI_CONTEXT_TOKEN_BUDGET: '32000' }).ai.contextTokenBudget).toBe(32000);
    expect(() => loadConfig({ ...BASE_ENV, AI_CONTEXT_TOKEN_BUDGET: '999' })).toThrow(/AI_CONTEXT_TOKEN_BUDGET/);
    expect(() => loadConfig({ ...BASE_ENV, AI_CONTEXT_TOKEN_BUDGET: '32001' })).toThrow(/AI_CONTEXT_TOKEN_BUDGET/);

    expect(loadConfig({ ...BASE_ENV, AI_REQUEST_TIMEOUT_MS: '5000' }).ai.requestTimeoutMs).toBe(5000);
    expect(loadConfig({ ...BASE_ENV, AI_REQUEST_TIMEOUT_MS: '120000' }).ai.requestTimeoutMs).toBe(120000);
    expect(() => loadConfig({ ...BASE_ENV, AI_REQUEST_TIMEOUT_MS: '4999' })).toThrow(/AI_REQUEST_TIMEOUT_MS/);
    expect(() => loadConfig({ ...BASE_ENV, AI_REQUEST_TIMEOUT_MS: '120001' })).toThrow(/AI_REQUEST_TIMEOUT_MS/);
  });
});

describe('loadConfig backup and alerts', () => {
  it('defaults to no token, no webhook and a ten GiB disk threshold', () => {
    const config = loadConfig(BASE_ENV);
    expect(config.backup).toEqual({ token: null });
    expect(config.alerts).toEqual({
      webhookUrl: null,
      diskFreeThresholdBytes: 10_737_418_240,
      staleHours: 24,
      monitorIntervalMs: 300_000,
    });
  });

  it('rejects a backup token shorter than 32 characters', () => {
    expect(() => loadConfig({ ...BASE_ENV, BACKUP_TOKEN: 'too-short' })).toThrow(
      /BACKUP_TOKEN must be at least 32 characters/,
    );
    expect(loadConfig({ ...BASE_ENV, BACKUP_TOKEN: 't'.repeat(32) }).backup.token).toBe('t'.repeat(32));
  });

  it('accepts only http and https alert webhooks', () => {
    expect(() => loadConfig({ ...BASE_ENV, ALERT_WEBHOOK_URL: 'ftp://x' })).toThrow(
      /ALERT_WEBHOOK_URL/,
    );
    expect(
      loadConfig({ ...BASE_ENV, ALERT_WEBHOOK_URL: 'https://alerts.example/hook' }).alerts.webhookUrl,
    ).toBe('https://alerts.example/hook');
  });

  it('rejects a zero disk alert threshold', () => {
    expect(() => loadConfig({ ...BASE_ENV, DISK_ALERT_FREE_BYTES: '0' })).toThrow(
      /DISK_ALERT_FREE_BYTES/,
    );
  });
});
