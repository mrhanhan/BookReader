import { describe, expect, it } from 'vitest';
import { loadConfig } from '../src/config';

const BASE_ENV: NodeJS.ProcessEnv = {
  DATABASE_URL: 'postgres://bookr:bookr@localhost:5432/bookr',
  S3_ENDPOINT: 'http://localhost:9000',
  JWT_SECRET: 's'.repeat(32),
};

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
