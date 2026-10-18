import { closeDb, createDb } from './client';
import { migrate } from './migrate';

const DEFAULT_TEST_DATABASE_URL = 'postgres://bookr:bookr@localhost:5432/bookr_test';

/**
 * Standalone migration entry point. Kept apart from `migrate.ts` so importing
 * the library never starts a CLI: when the server is bundled, its own entry
 * file is `dist/server.js`, which would otherwise match the argv check and run
 * a second migration concurrently with the server's.
 */
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

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
