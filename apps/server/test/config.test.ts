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
