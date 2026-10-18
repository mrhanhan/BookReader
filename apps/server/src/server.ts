import { newId } from '@bookr/shared';
import { buildApp } from './app';
import { CalibreConverter } from './books/conversion';
import { loadConfig } from './config';
import { closeDb, createDb } from './db/client';
import { PostgresJobQueue } from './jobs/queue';
import { S3Storage } from './storage/s3';

const config = loadConfig();
const db = createDb(config.databaseUrl);
const clock = { now: () => new Date() };

const app = buildApp({
  config,
  db,
  storage: new S3Storage(config.s3),
  clock,
  ids: { newId },
  jobs: new PostgresJobQueue(db, clock),
  converter: new CalibreConverter(),
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
