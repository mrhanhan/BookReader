import { newId } from '@bookr/shared';
import { buildApp } from './app';
import { loadConfig } from './config';
import { closeDb, createDb } from './db/client';
import { FakeJobQueue } from './jobs/fake';
import { FakeStorage } from './storage/fake';

const config = loadConfig();
const db = createDb(config.databaseUrl);

const app = buildApp({
  config,
  db,
  // Replaced by the S3 adapter and Postgres queue in the uploads task.
  storage: new FakeStorage(),
  clock: { now: () => new Date() },
  ids: { newId },
  jobs: new FakeJobQueue(),
});

async function shutdown(signal: string): Promise<void> {
  app.log.info({ signal }, 'shutting down');
  await app.close();
  await closeDb(db);
  process.exit(0);
}

process.on('SIGINT', () => {
  void shutdown('SIGINT');
});
process.on('SIGTERM', () => {
  void shutdown('SIGTERM');
});

try {
  await app.listen({ port: config.port, host: config.host });
} catch (error) {
  app.log.error({ errorName: error instanceof Error ? error.name : 'unknown' }, 'failed to start server');
  process.exit(1);
}
