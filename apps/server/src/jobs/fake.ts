import type { Job, JobQueue } from './types';

/** In-memory queue used by tests and the initial server skeleton. */
export class FakeJobQueue implements JobQueue {
  readonly jobs: Job[] = [];

  async enqueue(job: Job): Promise<void> {
    this.jobs.push(job);
  }

  clear(): void {
    this.jobs.length = 0;
  }
}
