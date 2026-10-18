import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import pg from 'pg';

/** Drizzle client bound to a Postgres connection pool. */
export type Database = NodePgDatabase<Record<string, never>> & { $client: pg.Pool };

/**
 * Creates a database client without opening a connection. The pool connects
 * lazily on the first query, so health checks do not require a live database.
 */
export function createDb(databaseUrl: string): Database {
  return drizzle(new pg.Pool({ connectionString: databaseUrl, max: 10 }));
}

/** Closes the underlying pool, waiting for in-flight queries to finish. */
export async function closeDb(db: Database): Promise<void> {
  await db.$client.end();
}
