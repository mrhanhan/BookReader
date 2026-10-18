import type { AppDeps } from '../app';
import { runMetadataJob } from '../books/metadata';
import type { ClaimedJob } from './types';

/** How often the worker looks for pending jobs. */
export const WORKER_POLL_INTERVAL_MS = 5_000;

/** A job type this worker cannot handle (for example `convert` before Task 9b). */
class UnsupportedJobError extends Error {
  constructor(type: string) {
    super(`Unsupported job type: ${type}`);
    this.name = 'UnsupportedJobError';
  }
}

/** A job row whose payload does not match its type. */
class JobPayloadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobPayloadError';
  }
}

function payloadBookId(payload: Record<string, unknown>): string {
  const bookId = payload.bookId;
  if (typeof bookId !== 'string' || bookId.length === 0) {
    throw new JobPayloadError('Job payload is missing bookId');
  }
  return bookId;
}

/** Runs one claimed job; `metadata` is the only handler in this task. */
async function runJob(deps: AppDeps, job: ClaimedJob): Promise<void> {
  switch (job.type) {
    case 'metadata':
      await runMetadataJob(deps, payloadBookId(job.payload));
      return;
    case 'convert':
    case 'cleanup':
      throw new UnsupportedJobError(job.type);
    default:
      // Rows can carry types written by a newer server version; do not
      // silently complete work this build cannot perform.
      throw new UnsupportedJobError(String(job.type));
  }
}

/** Errors from our own handlers are safe to store; anything else keeps only its class. */
function failureReason(error: unknown): string {
  if (error instanceof UnsupportedJobError || error instanceof JobPayloadError) {
    return error.message;
  }
  return error instanceof Error ? error.name : 'UnknownError';
}

/** Claims and runs one job. Returns false when the queue is empty. */
export async function runNextJob(deps: AppDeps): Promise<boolean> {
  const job = await deps.jobs.claimNext();
  if (!job) {
    return false;
  }

  try {
    await runJob(deps, job);
    await deps.jobs.complete(job.id);
  } catch (error) {
    await deps.jobs.fail(job.id, failureReason(error)).catch(() => undefined);
  }
  return true;
}

export interface WorkerOptions {
  /** Overrides the poll interval, primarily for tests. */
  pollIntervalMs?: number;
}

/**
 * Starts the background worker. Jobs are drained every five seconds; unknown
 * job types are failed with a clear reason instead of being silently dropped.
 * Returns an async stop function that waits for an in-flight tick.
 */
export function startWorker(deps: AppDeps, options: WorkerOptions = {}): () => Promise<void> {
  const intervalMs = options.pollIntervalMs ?? WORKER_POLL_INTERVAL_MS;
  let stopped = false;
  let inFlight: Promise<void> | null = null;

  const tick = async (): Promise<void> => {
    while (!stopped && (await runNextJob(deps))) {
      // Drain the queue; each iteration already handled one job.
    }
  };

  const timer = setInterval(() => {
    if (stopped || inFlight) {
      return;
    }
    inFlight = tick()
      .catch((error: unknown) => {
        const errorName = error instanceof Error ? error.name : 'UnknownError';
        console.error(`[worker] poll failed with ${errorName}`);
      })
      .finally(() => {
        inFlight = null;
      });
  }, intervalMs);
  timer.unref?.();

  return async () => {
    stopped = true;
    clearInterval(timer);
    await inFlight;
  };
}
