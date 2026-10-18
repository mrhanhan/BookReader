import { setTimeout as delay } from 'node:timers/promises';
import { bootstrapAiConfig } from './ai/config';
import { buildApp } from './app';
import { loadConfig } from './config';
import { closeDb } from './db/client';
import { migrate } from './db/migrate';
import { startWorker } from './jobs/worker';
import { createDeps } from './runtime';
import {
  enqueuePendingConversionJobs,
  enqueuePendingMetadataJobs,
  startDailyCleanup,
} from './startup';
import { ensureBucket } from './storage/s3';

/** Startup dependencies may come up slightly after their health checks pass. */
const STARTUP_RETRY_ATTEMPTS = 30;
const STARTUP_RETRY_DELAY_MS = 2_000;

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : typeof error;
}

/** Retries a startup step (database, object storage) with a short fixed delay. */
async function withStartupRetry(label: string, task: () => Promise<void>): Promise<void> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      await task();
      return;
    } catch (error) {
      if (attempt >= STARTUP_RETRY_ATTEMPTS) {
        throw new Error(`${label} failed after ${STARTUP_RETRY_ATTEMPTS} attempts (${errorName(error)})`);
      }
      console.error(
        `[startup] ${label} failed (attempt ${attempt}/${STARTUP_RETRY_ATTEMPTS}) with ${errorName(error)}; retrying`,
      );
      await delay(STARTUP_RETRY_DELAY_MS);
    }
  }
}

async function main(): Promise<void> {
  const config = loadConfig();
  const deps = createDeps(config);
  const db = deps.db;
  const app = buildApp(deps);

  await withStartupRetry('database migrations', () => migrate(db));

  if (config.ai.fakeProvider) {
    app.log.warn('AI fake provider enabled — never use in production');
  }
  try {
    await bootstrapAiConfig(deps);
  } catch (error) {
    // A bad bootstrap value must not keep the shelf down; an administrator can
    // enter the provider settings through the admin API instead.
    app.log.error(
      {
        errorName: errorName(error),
        message: error instanceof Error ? error.message : String(error),
      },
      'failed to bootstrap AI configuration',
    );
  }
  await withStartupRetry('S3 bucket creation', () => ensureBucket(config.s3));

  try {
    const requeued = await enqueuePendingMetadataJobs(deps);
    if (requeued > 0) {
      app.log.info({ requeued }, 'queued metadata jobs for pending books');
    }
  } catch (error) {
    // Metadata can still be retried by hand; refusing to serve books is worse.
    app.log.error({ errorName: errorName(error) }, 'failed to queue metadata jobs for pending books');
  }

  try {
    const requeued = await enqueuePendingConversionJobs(deps);
    if (requeued > 0) {
      app.log.info({ requeued }, 'queued conversion jobs for pending books');
    }
  } catch (error) {
    // The uploader can retry the conversion from the book card.
    app.log.error(
      { errorName: errorName(error) },
      'failed to queue conversion jobs for pending books',
    );
  }

  const stopWorker = startWorker(deps);
  const stopCleanup = startDailyCleanup(deps);

  let shuttingDown = false;
  async function shutdown(signal: string): Promise<void> {
    if (shuttingDown) {
      return;
    }
    shuttingDown = true;
    app.log.info({ signal }, 'shutting down');
    stopCleanup();
    await stopWorker();
    await app.close();
    await closeDb(db);
  }

  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.on(signal, () => {
      void shutdown(signal).finally(() => process.exit(0));
    });
  }

  try {
    await app.listen({ port: config.port, host: config.host });
  } catch (error) {
    app.log.error({ errorName: errorName(error) }, 'failed to start server');
    stopCleanup();
    await stopWorker();
    await closeDb(db);
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`[startup] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
