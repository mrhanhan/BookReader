import { newId } from '@bookr/shared';
import type { AppDeps } from './app';
import { CalibreConverter } from './books/conversion';
import { ProcessMetadataRunner } from './books/metadata-runner';
import type { AppConfig } from './config';
import { createDb, type Database } from './db/client';
import { PostgresJobQueue } from './jobs/queue';
import { S3Storage } from './storage/s3';
import { createSyncHub } from './sync/hub';

/**
 * Builds the production dependency graph. Tests inject fakes instead; the
 * server and the bootstrapping CLI both run against these real adapters.
 */
export function createDeps(
  config: AppConfig,
  db: Database = createDb(config.databaseUrl),
): AppDeps {
  const clock = { now: () => new Date() };
  return {
    config,
    db,
    storage: new S3Storage(config.s3),
    clock,
    ids: { newId },
    jobs: new PostgresJobQueue(db, clock),
    converter: new CalibreConverter(),
    metadataRunner: new ProcessMetadataRunner(),
    syncHub: createSyncHub(),
  };
}
