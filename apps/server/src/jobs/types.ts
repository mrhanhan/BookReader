/** Background work handled by the job worker. */
export type Job =
  | { type: 'metadata'; bookId: string }
  | { type: 'convert'; bookId: string }
  | { type: 'cleanup' };

/** Queue used by request handlers to hand work to background jobs. */
export interface JobQueue {
  enqueue(job: Job): Promise<void>;
}
