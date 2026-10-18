/**
 * Extracts the database name from a Postgres connection URL without echoing
 * credentials in error messages.
 */
export function databaseNameOf(databaseUrl: string): string {
  let pathname: string;
  try {
    pathname = new URL(databaseUrl).pathname;
  } catch {
    throw new Error('Invalid database URL');
  }

  const name = decodeURIComponent(pathname.replace(/^\//, ''));
  if (name === '') {
    throw new Error('Database URL does not name a database');
  }
  return name;
}

/**
 * Refuses to touch a database whose name does not end with `_test`, so a
 * misconfigured environment can never truncate a real library.
 */
export function assertTestDatabase(databaseUrl: string): void {
  const name = databaseNameOf(databaseUrl);
  if (!name.endsWith('_test')) {
    throw new Error(`Refusing to use database "${name}": the test database name must end with "_test"`);
  }
}
