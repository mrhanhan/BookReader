import { backfillMissingCovers } from '../books/cover-backfill';
import { loadConfig } from '../config';
import { closeDb } from '../db/client';
import { createDeps } from '../runtime';

/** Parses `COVER_BACKFILL_LIMIT`, which must be a positive integer when set. */
function coverBackfillLimit(raw: string | undefined): number | undefined {
  if (raw === undefined || raw.trim() === '') {
    return undefined;
  }
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    throw new Error('COVER_BACKFILL_LIMIT must be a positive integer');
  }
  return value;
}

/** Extracts covers for books that were uploaded before cover detection existed. */
async function main(): Promise<void> {
  const limit = coverBackfillLimit(process.env.COVER_BACKFILL_LIMIT);
  const config = loadConfig();
  const deps = createDeps(config);
  try {
    const result = await backfillMissingCovers(deps, limit !== undefined ? { limit } : {});
    console.log(JSON.stringify(result));
  } finally {
    await closeDb(deps.db);
  }
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
