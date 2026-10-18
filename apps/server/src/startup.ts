import { and, eq, isNull, sql } from 'drizzle-orm';
import { cleanupExpiredReflowUploads } from './books/reflow';
import { cleanupTrash } from './books/service';
import type { AppDeps } from './app';
import { books, jobs } from './db/schema';
import { cleanupExpiredUploads } from './uploads/service';

const DAY_MS = 24 * 60 * 60 * 1000;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/**
 * Enqueues metadata extraction for books left `pending` by a crash or a queue
 * outage. A pending/running metadata job for the same book means the work is
 * already covered, so restarts never pile up duplicate jobs.
 */
export async function enqueuePendingMetadataJobs(deps: AppDeps): Promise<number> {
  const stuck = await deps.db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        eq(books.metadataStatus, 'pending'),
        isNull(books.deletedAt),
        sql`not exists (
          select 1 from ${jobs}
          where ${jobs.type} = 'metadata'
            and ${jobs.status} in ('pending', 'running')
            and ${jobs.payload}->>'bookId' = ${books.id}::text
        )`,
      ),
    );

  for (const book of stuck) {
    await deps.jobs.enqueue({ type: 'metadata', bookId: book.id });
  }
  return stuck.length;
}

/**
 * Enqueues conversions for books left `pending` by a crash or a queue outage
 * (for example between the upload commit and the convert enqueue). A queued or
 * running job for the same book already covers the work, so restarts never
 * pile up duplicates.
 */
export async function enqueuePendingConversionJobs(deps: AppDeps): Promise<number> {
  const stuck = await deps.db
    .select({ id: books.id })
    .from(books)
    .where(
      and(
        eq(books.conversionStatus, 'pending'),
        isNull(books.deletedAt),
        sql`not exists (
          select 1 from ${jobs}
          where ${jobs.type} = 'convert'
            and ${jobs.status} in ('pending', 'running')
            and ${jobs.payload}->>'bookId' = ${books.id}::text
        )`,
      ),
    );

  for (const book of stuck) {
    await deps.jobs.enqueue({ type: 'convert', bookId: book.id });
  }
  return stuck.length;
}

/**
 * Runs the retention sweeps once at startup and then daily: abandoned upload
 * sessions are expired (their objects deleted) and books that sat in the trash
 * for the retention window are purged permanently.
 */
export function startDailyCleanup(deps: AppDeps): () => void {
  let inFlight = false;

  const run = async (): Promise<void> => {
    if (inFlight) {
      return;
    }
    inFlight = true;
    try {
      const uploads = await cleanupExpiredUploads(deps);
      const reflowUploads = await cleanupExpiredReflowUploads(deps);
      const purged = await cleanupTrash(deps);
      console.log(
        `[cleanup] expired ${uploads} upload sessions, ${reflowUploads} reflow upload sessions and purged ${purged} trashed books`,
      );
    } catch (error) {
      console.error(`[cleanup] daily sweep failed with ${errorName(error)}`);
    } finally {
      inFlight = false;
    }
  };

  const timer = setInterval(() => void run(), DAY_MS);
  timer.unref?.();
  void run();

  return () => clearInterval(timer);
}
