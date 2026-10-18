import { jobPayload, type ClaimedJob, type Job, type JobQueue } from './types';

/** In-memory queue used by tests and the initial server skeleton. */
export class FakeJobQueue implements JobQueue {
  /** Every job ever enqueued, in order; tests assert against this history. */
  readonly jobs: Job[] = [];

  private readonly pending: ClaimedJob[] = [];
  private sequence = 0;

  async enqueue(job: Job): Promise<void> {
    this.jobs.push(job);
    this.sequence += 1;
    this.pending.push({
      id: `fake-job-${this.sequence}`,
      type: job.type,
      payload: jobPayload(job),
      attempts: 0,
      maxAttempts: 3,
    });
  }

  async claimNext(): Promise<ClaimedJob | null> {
    return this.pending.shift() ?? null;
  }

  async complete(_jobId: string): Promise<void> {
    // The fake queue keeps no completion state; recorded jobs stay visible.
  }

  async fail(_jobId: string, _error: string): Promise<void> {
    // The fake queue does not retry; tests only assert enqueued work.
  }

  clear(): void {
    this.jobs.length = 0;
    this.pending.length = 0;
  }
}
