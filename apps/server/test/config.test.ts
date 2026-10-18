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

  it('parses true and false', () => {
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'true' }).trustProxy).toBe(true);
    expect(loadConfig({ ...BASE_ENV, TRUST_PROXY: 'false' }).trustProxy).toBe(false);
  });

  it('rejects other values', () => {
    expect(() => loadConfig({ ...BASE_ENV, TRUST_PROXY: 'yes' })).toThrow(/TRUST_PROXY/);
  });
});
