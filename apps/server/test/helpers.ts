import { LIBRARY_QUOTA_BYTES, MEMBER_UPLOAD_QUOTA_BYTES, newId } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps, type Clock } from '../src/app';
import type { AppConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { FakeJobQueue } from '../src/jobs/fake';
import type { Job } from '../src/jobs/types';
import { FakeStorage } from '../src/storage/fake';

const TEST_DATABASE_URL = process.env.DATABASE_URL ?? 'postgres://bookr:bookr@localhost:5432/bookr';

/** Drizzle client shared by tests; it connects lazily on first use. */
export const testDb = createDb(TEST_DATABASE_URL);

/** In-memory storage shared by the test app and background jobs. */
export const fakeStorage = new FakeStorage();

const fakeJobQueue = new FakeJobQueue();

const DEFAULT_CONFIG: AppConfig = {
  port: 3000,
  host: '0.0.0.0',
  databaseUrl: TEST_DATABASE_URL,
  s3: {
    endpoint: 'http://localhost:9000',
    region: 'us-east-1',
    accessKey: 'test-access-key',
    secretKey: 'test-secret-key',
    bucket: 'bookr',
  },
  jwtSecret: 'test-jwt-secret-value-at-least-32-chars',
  libraryQuotaBytes: LIBRARY_QUOTA_BYTES,
  memberUploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
  loginRateLimit: 10,
  corsOrigin: 'http://localhost:5173',
};

/** Builds a test config, merging top-level overrides and nested S3 settings. */
export function buildTestConfig(overrides: Partial<AppConfig> = {}): AppConfig {
  return {
    ...DEFAULT_CONFIG,
    ...overrides,
    s3: { ...DEFAULT_CONFIG.s3, ...(overrides.s3 ?? {}) },
  };
}

/** Jobs recorded by the fake queue since the process started. */
export function enqueuedJobs(): Job[] {
  return fakeJobQueue.jobs;
}

/** Dependency object shared by the app and background jobs in tests. */
export async function buildTestDeps(overrides: Partial<AppConfig> = {}): Promise<AppDeps> {
  const clock: Clock = { now: () => new Date() };
  return {
    config: buildTestConfig(overrides),
    db: testDb,
    storage: fakeStorage,
    clock,
    ids: { newId },
    jobs: fakeJobQueue,
  };
}

/** Builds the app with fake dependencies, without touching Postgres or S3. */
export async function buildTestApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  return buildApp(await buildTestDeps(overrides));
}
