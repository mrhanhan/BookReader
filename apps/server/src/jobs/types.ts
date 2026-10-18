import type { JobType } from '../db/schema';

/** Background work handled by the job worker. */
export type Job =
  | { type: 'metadata'; bookId: string }
  | { type: 'convert'; bookId: string }
  | { type: 'cleanup' };

/** A job row claimed by a worker. */
export interface ClaimedJob {
  id: string;
  type: JobType;
  payload: Record<string, unknown>;
  attempts: number;
  maxAttempts: number;
}

/** Queue used by request handlers to hand work to background jobs. */
export interface JobQueue {
  enqueue(job: Job): Promise<void>;
  claimNext(): Promise<ClaimedJob | null>;
  complete(jobId: string): Promise<void>;
  /** Records a failure, scheduling a retry until the attempt cap is reached. */
  fail(jobId: string, error: string): Promise<void>;
}

/** Serialises a job into the `jobs.payload` column. */
export function jobPayload(job: Job): Record<string, unknown> {
  switch (job.type) {
    case 'metadata':
    case 'convert':
      return { bookId: job.bookId };
    case 'cleanup':
      return {};
  }
}
