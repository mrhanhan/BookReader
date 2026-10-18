import { describe, expect, it } from 'vitest';
import { assertTestDatabase, databaseNameOf } from '../src/db/guard';

describe('databaseNameOf', () => {
  it('reads the database name from a connection URL', () => {
    expect(databaseNameOf('postgres://bookr:bookr@localhost:5432/bookr_test')).toBe('bookr_test');
  });
  it('rejects a malformed URL without echoing it', () => {
    expect(() => databaseNameOf('not a url')).toThrow('Invalid database URL');
  });
});

describe('assertTestDatabase', () => {
  it('accepts a database whose name ends with _test', () => {
    expect(() => assertTestDatabase('postgres://bookr:bookr@localhost:5432/bookr_test')).not.toThrow();
  });
  it('refuses a production database', () => {
    expect(() => assertTestDatabase('postgres://bookr:bookr@localhost:5432/bookr')).toThrow(
      /must end with "_test"/,
    );
  });
  it('refuses names that merely contain _test', () => {
    expect(() => assertTestDatabase('postgres://bookr:bookr@localhost:5432/bookr_test_backup')).toThrow(
      /must end with "_test"/,
    );
  });
});
