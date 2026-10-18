import type { ExtractTablesWithRelations } from 'drizzle-orm';
import { drizzle, type NodePgDatabase } from 'drizzle-orm/node-postgres';
import type { NodePgQueryResultHKT } from 'drizzle-orm/node-postgres';
import type { PgTransaction } from 'drizzle-orm/pg-core';
import pg from 'pg';

/** Drizzle client bound to a Postgres connection pool. */
export type Database = NodePgDatabase<Record<string, never>> & { $client: pg.Pool };

/**
 * A Drizzle transaction over the application database. Repo functions that
 * participate in a caller-managed transaction take this instead of `Database`.
 */
export type Transaction = PgTransaction<
  NodePgQueryResultHKT,
  Record<string, never>,
  ExtractTablesWithRelations<Record<string, never>>
>;

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
