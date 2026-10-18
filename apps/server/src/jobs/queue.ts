import { and, asc, eq, isNull, lt, lte, or } from 'drizzle-orm';
import type { Clock } from '../app';
import type { Database } from '../db/client';
import { jobs } from '../db/schema';
import { jobPayload, type ClaimedJob, type Job, type JobQueue } from './types';

/** First retry delay; each further attempt doubles it. */
const RETRY_BASE_MS = 60_000;

/** Upper bound so a long-lived failure does not park a job for days. */
const RETRY_MAX_MS = 60 * 60 * 1000;

/**
 * How long a worker may hold a job before another worker may steal it. A
 * crashed worker cannot release its claim, so stale `running` rows are
 * returned to the pending pool on the next claim.
 */
const JOB_LEASE_MS = 5 * 60 * 1000;

function backoffMs(attempts: number): number {
  return Math.min(RETRY_BASE_MS * 2 ** Math.max(0, attempts - 1), RETRY_MAX_MS);
}

/**
 * Postgres-backed job queue. Workers claim rows with `FOR UPDATE SKIP LOCKED`,
 * so several workers can run in parallel without handing out the same job.
 */
export class PostgresJobQueue implements JobQueue {
  constructor(
    private readonly db: Database,
    private readonly clock: Clock,
  ) {}

  async enqueue(job: Job): Promise<void> {
    await this.db.insert(jobs).values({
      type: job.type,
      payload: jobPayload(job),
      runAt: this.clock.now(),
    });
  }

  async claimNext(): Promise<ClaimedJob | null> {
    const now = this.clock.now();
    return this.db.transaction(async (tx) => {
      // Reclaim jobs whose worker died while holding the lease.
      await tx
        .update(jobs)
        .set({ status: 'pending', lockedAt: null, updatedAt: now })
        .where(
          and(
            eq(jobs.status, 'running'),
            or(
              isNull(jobs.lockedAt),
              lt(jobs.lockedAt, new Date(now.getTime() - JOB_LEASE_MS)),
            ),
          ),
        );

      const [row] = await tx
        .select({
          id: jobs.id,
          type: jobs.type,
          payload: jobs.payload,
          attempts: jobs.attempts,
          maxAttempts: jobs.maxAttempts,
        })
        .from(jobs)
        .where(and(eq(jobs.status, 'pending'), lte(jobs.runAt, now)))
        .orderBy(asc(jobs.runAt), asc(jobs.createdAt))
        .limit(1)
        .for('update', { skipLocked: true });

      if (!row) {
        return null;
      }

      await tx
        .update(jobs)
        .set({ status: 'running', lockedAt: now, updatedAt: now })
        .where(eq(jobs.id, row.id));

      return {
        id: row.id,
        type: row.type,
        payload: (row.payload ?? {}) as Record<string, unknown>,
        attempts: row.attempts,
        maxAttempts: row.maxAttempts,
      };
    });
  }

  async complete(jobId: string): Promise<void> {
    await this.db
      .update(jobs)
      .set({ status: 'done', lockedAt: null, lastError: null, updatedAt: this.clock.now() })
      .where(eq(jobs.id, jobId));
  }

  async fail(jobId: string, error: string): Promise<void> {
    const now = this.clock.now();
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .select({ attempts: jobs.attempts, maxAttempts: jobs.maxAttempts })
        .from(jobs)
        .where(eq(jobs.id, jobId))
        .limit(1)
        .for('update');

      if (!row) {
        return;
      }

      const attempts = row.attempts + 1;
      const exhausted = attempts >= row.maxAttempts;
      await tx
        .update(jobs)
        .set({
          attempts,
          lastError: error.slice(0, 2000),
          status: exhausted ? 'failed' : 'pending',
          runAt: exhausted ? now : new Date(now.getTime() + backoffMs(attempts)),
          lockedAt: null,
          updatedAt: now,
        })
        .where(eq(jobs.id, jobId));
    });
  }
}
