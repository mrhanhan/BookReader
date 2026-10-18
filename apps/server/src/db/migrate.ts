import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import { closeDb, createDb, type Database } from './client';

const DEFAULT_TEST_DATABASE_URL = 'postgres://bookr:bookr@localhost:5432/bookr_test';

const MIGRATIONS_FOLDER =
  process.env.MIGRATIONS_DIR ?? fileURLToPath(new URL('../../drizzle', import.meta.url));

/** Applies every pending SQL migration in `apps/server/drizzle`. */
export async function migrate(db: Database): Promise<void> {
  await runMigrations(db, { migrationsFolder: MIGRATIONS_FOLDER });
}

async function main(): Promise<void> {
  const useTestDatabase = process.argv.includes('--test');
  const databaseUrl = useTestDatabase
    ? (process.env.TEST_DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL)
    : (process.env.DATABASE_URL ?? DEFAULT_TEST_DATABASE_URL);

  const db = createDb(databaseUrl);
  try {
    await migrate(db);
  } finally {
    await closeDb(db);
  }
}

const entryPoint = process.argv[1];
if (entryPoint !== undefined && path.resolve(entryPoint) === fileURLToPath(import.meta.url)) {
  main().catch((error: unknown) => {
    console.error(error instanceof Error ? error.message : error);
    process.exitCode = 1;
  });
}
