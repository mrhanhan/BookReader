import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { migrate as runMigrations } from 'drizzle-orm/node-postgres/migrator';
import type { Database } from './client';

/**
 * Locates `apps/server/drizzle`. Migrations run from `src/db` under tsx/vitest
 * and from `dist/server.js` in production, so the relative path differs per
 * layout. `MIGRATIONS_DIR` overrides the search (the Docker image sets it).
 */
function resolveMigrationsFolder(): string {
  const configured = process.env.MIGRATIONS_DIR;
  if (configured) {
    return configured;
  }

  const candidates = [
    // src/db/migrate.ts
    fileURLToPath(new URL('../../drizzle', import.meta.url)),
    // dist/server.js
    fileURLToPath(new URL('../drizzle', import.meta.url)),
  ];
  return candidates.find((candidate) => existsSync(candidate)) ?? candidates[0]!;
}

/** Applies every pending SQL migration in `apps/server/drizzle`. */
export async function migrate(db: Database): Promise<void> {
  await runMigrations(db, { migrationsFolder: resolveMigrationsFolder() });
}
