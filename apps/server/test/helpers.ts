import {
  LIBRARY_QUOTA_BYTES,
  MEMBER_UPLOAD_QUOTA_BYTES,
  newId,
  type AuthTokens,
  type BookConversionStatus,
  type BookFormat,
  type BookStatus,
  type Role,
} from '@bookr/shared';
import { eq } from 'drizzle-orm';
import type { FastifyInstance } from 'fastify';
import { buildApp, type AppDeps, type Clock } from '../src/app';
import { hashPassword } from '../src/auth/password';
import { signAccessToken } from '../src/auth/tokens';
import type { AppConfig } from '../src/config';
import { createDb } from '../src/db/client';
import { assertTestDatabase } from '../src/db/guard';
import { migrate } from '../src/db/migrate';
import {
  books,
  invites,
  libraries,
  uploadSessions,
  users,
  type BookRow,
  type MetadataStatus,
} from '../src/db/schema';
import { FakeJobQueue } from '../src/jobs/fake';
import type { Job } from '../src/jobs/types';
import { LIBRARY_ID, LIBRARY_NAME } from '../src/library/service';
import { FakeStorage } from '../src/storage/fake';
import { cleanupExpiredUploads } from '../src/uploads/service';

const TEST_DATABASE_URL =
  process.env.TEST_DATABASE_URL ?? 'postgres://bookr:bookr@localhost:5432/bookr_test';

/** Lock that serialises migrations when test files run in parallel. */
const MIGRATION_LOCK_ID = 741_852_963;

/** Drizzle client shared by tests; it connects lazily on first use. */
export const testDb = createDb(TEST_DATABASE_URL);

let schemaReady: Promise<void> | undefined;

async function migrateOnce(): Promise<void> {
  const client = await testDb.$client.connect();
  try {
    await client.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_ID]);
    await migrate(testDb);
  } finally {
    await client.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_ID]);
    client.release();
  }
}

/**
 * Applies migrations once per process, then empties every application table so
 * test files and individual tests never observe each other's rows.
 */
export async function resetDb(): Promise<void> {
  assertTestDatabase(TEST_DATABASE_URL);
  schemaReady ??= migrateOnce();
  await schemaReady;

  const { rows } = await testDb.$client.query<{ tablename: string }>(
    "SELECT tablename FROM pg_tables WHERE schemaname = 'public'",
  );
  if (rows.length === 0) {
    return;
  }
  const tables = rows.map((row) => `"${row.tablename}"`).join(', ');
  await testDb.$client.query(`TRUNCATE TABLE ${tables} RESTART IDENTITY CASCADE`);
  fakeStorage.clear();
  fakeJobQueue.clear();
}

/** In-memory storage shared by the test app and background jobs. */
export const fakeStorage = new FakeStorage();

const fakeJobQueue = new FakeJobQueue();

const DEFAULT_CONFIG: AppConfig = {
  port: 3000,
  host: '0.0.0.0',
  trustProxy: false,
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

/** Fields accepted by `seedBook`; everything has a sensible default. */
export interface SeedBookInput {
  uploadedBy: string;
  libraryId?: string;
  title?: string;
  author?: string | null;
  description?: string | null;
  format?: BookFormat;
  originalFilename?: string;
  size?: number;
  sha256?: string;
  fileKey?: string | null;
  coverKey?: string | null;
  status?: BookStatus;
  metadataStatus?: MetadataStatus;
  conversionStatus?: BookConversionStatus;
  deletedAt?: Date | null;
  createdAt?: Date;
}

function randomSha256(): string {
  return `${newId().replaceAll('-', '')}${newId().replaceAll('-', '')}`;
}

/**
 * Inserts a book directly, creating the shared library first when needed.
 * Returns the stored row so tests can assert on ids and storage keys.
 */
export async function seedBook(input: SeedBookInput): Promise<BookRow> {
  const libraryId = input.libraryId ?? LIBRARY_ID;
  await testDb
    .insert(libraries)
    .values({ id: libraryId, name: LIBRARY_NAME })
    .onConflictDoNothing({ target: libraries.id });

  const format = input.format ?? 'pdf';
  const title = input.title ?? 'Test Book';
  const [book] = await testDb
    .insert(books)
    .values({
      libraryId,
      uploadedBy: input.uploadedBy,
      title,
      author: input.author ?? null,
      description: input.description ?? null,
      format,
      originalFilename: input.originalFilename ?? `${title}.${format}`,
      size: input.size ?? 10,
      sha256: input.sha256 ?? randomSha256(),
      fileKey:
        input.fileKey === undefined
          ? `library/${libraryId}/books/${newId()}/original.${format}`
          : input.fileKey,
      coverKey: input.coverKey ?? null,
      status: input.status ?? 'unread',
      metadataStatus: input.metadataStatus ?? 'done',
      conversionStatus: input.conversionStatus ?? 'none',
      deletedAt: input.deletedAt ?? null,
      ...(input.createdAt ? { createdAt: input.createdAt } : {}),
    })
    .returning();

  if (!book) {
    throw new Error('seedBook could not insert a book');
  }
  return book;
}

/** Reads the storage key of an upload session created through the API. */
export async function findSessionObjectKey(uploadId: string): Promise<string> {
  const [session] = await testDb
    .select({ objectKey: uploadSessions.objectKey })
    .from(uploadSessions)
    .where(eq(uploadSessions.id, uploadId))
    .limit(1);
  if (!session) {
    throw new Error(`Upload session ${uploadId} does not exist`);
  }
  return session.objectKey;
}

/** Backdates a session's expiry so cleanup and completion see it as stale. */
export async function expireSession(uploadId: string, msAgo: number): Promise<void> {
  await testDb
    .update(uploadSessions)
    .set({ expiresAt: new Date(Date.now() - msAgo) })
    .where(eq(uploadSessions.id, uploadId));
}

/** Runs the expired-session sweep against the shared test dependencies. */
export async function cleanupExpiredUploadsForTest(): Promise<number> {
  return cleanupExpiredUploads(await buildTestDeps());
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

/** Password every seeded test user shares. */
export const SEEDED_PASSWORD = 'valid-password-1';

/** A user inserted by `seedUser`. */
export interface SeededUser {
  id: string;
  username: string;
  password: string;
  role: Role;
}

let seededPasswordHash: Promise<string> | undefined;

/**
 * Inserts a user with a real Argon2id hash so login flows can be exercised.
 * Users are global in this system, so no library row is created.
 */
export async function seedUser(role: Role, username?: string): Promise<SeededUser> {
  seededPasswordHash ??= hashPassword(SEEDED_PASSWORD);
  const resolvedUsername = username ?? `${role}_${newId().replaceAll('-', '').slice(0, 12)}`;
  const [user] = await testDb
    .insert(users)
    .values({
      username: resolvedUsername,
      passwordHash: await seededPasswordHash,
      displayName: resolvedUsername,
      role,
    })
    .returning();
  return { id: user!.id, username: user!.username, password: SEEDED_PASSWORD, role: user!.role };
}

/** Builds an `Authorization` header carrying a valid access token for a user. */
export async function authHeader(
  user: Pick<SeededUser, 'id' | 'role'>,
  secret: string = DEFAULT_CONFIG.jwtSecret,
): Promise<{ authorization: string }> {
  const token = await signAccessToken({ sub: user.id, role: user.role }, secret);
  return { authorization: `Bearer ${token}` };
}

/** Builds the app with fake dependencies, without touching Postgres or S3. */
export async function buildTestApp(overrides: Partial<AppConfig> = {}): Promise<FastifyInstance> {
  return buildApp(await buildTestDeps(overrides));
}

/** Options for `createInvite`, used to exercise invalid invite states. */
export interface CreateInviteOptions {
  expiresAt?: Date;
  revokedAt?: Date;
  usedBy?: string;
}

const DAY_MS = 24 * 60 * 60 * 1000;

/**
 * Inserts an unused invite directly, keeping auth tests independent of the
 * admin invite routes that will consume `POST /api/admin/invites`.
 */
export async function createInvite(
  _app: FastifyInstance,
  options: CreateInviteOptions = {},
): Promise<string> {
  const code = `INV${newId().replaceAll('-', '').slice(0, 16)}`;
  await testDb.insert(invites).values({
    code,
    expiresAt: options.expiresAt ?? new Date(Date.now() + DAY_MS),
    revokedAt: options.revokedAt ?? null,
    usedBy: options.usedBy ?? null,
  });
  return code;
}

/** Marks a user account as disabled so login and refresh must reject it. */
export async function setUserInactive(_app: FastifyInstance, username: string): Promise<void> {
  await testDb.update(users).set({ isActive: false }).where(eq(users.username, username));
}

/** Logs a seeded user in and returns the issued tokens. */
export async function loginAs(app: FastifyInstance, user: SeededUser): Promise<AuthTokens> {
  const response = await app.inject({
    method: 'POST',
    url: '/api/auth/login',
    payload: { username: user.username, password: user.password },
  });
  if (response.statusCode !== 200) {
    throw new Error(`loginAs(${user.username}) failed with status ${response.statusCode}`);
  }
  return response.json<AuthTokens>();
}
