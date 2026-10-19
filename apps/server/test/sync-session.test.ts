import { newId, syncKey, type SyncPushChange } from '@bookr/shared';
import type { FastifyInstance } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { beforeEach, expect, it } from 'vitest';
import { dailyStats, readingSessions } from '../src/db/schema';
import {
  authHeader,
  buildTestApp,
  resetDb,
  seedBook,
  seedUser,
  testDb,
  type SeededUser,
} from './helpers';

const STARTED = '2026-10-19T02:00:00.000Z'; // 10:00 in Shanghai
const ENDED = '2026-10-19T02:10:00.000Z';
const CLIENT_TIME = '2026-10-19T02:11:00.000Z';
const SESSION_ID = '0190f0e0-0000-7000-8000-0000000000aa';

let app: FastifyInstance;
let user: SeededUser;
let bookId: string;

beforeEach(async () => {
  await resetDb();
  app = await buildTestApp();
  user = await seedUser('member');
  const book = await seedBook({ uploadedBy: user.id });
  bookId = book.id;
});

function sessionChange(overrides: {
  id?: string;
  clientUpdatedAt?: string;
  startedAt?: string;
  endedAt?: string;
  activeSeconds?: number;
  pagesRead?: number;
  op?: 'upsert' | 'delete';
  book?: string;
} = {}): SyncPushChange {
  return {
    entityType: 'reading_session',
    entityId: overrides.id ?? SESSION_ID,
    op: overrides.op ?? 'upsert',
    clientUpdatedAt: overrides.clientUpdatedAt ?? CLIENT_TIME,
    payload: {
      bookId: overrides.book ?? bookId,
      startedAt: overrides.startedAt ?? STARTED,
      endedAt: overrides.endedAt ?? ENDED,
      activeSeconds: overrides.activeSeconds ?? 600,
      pagesRead: overrides.pagesRead ?? 4,
    },
  };
}

async function push(change: SyncPushChange) {
  const response = await app.inject({
    method: 'POST',
    url: '/api/sync/push',
    headers: await authHeader(user),
    payload: { changes: [change] },
  });
  expect(response.statusCode).toBe(200);
  return response.json() as {
    applied: unknown[];
    skipped: string[];
    rejected: Array<{ key: string; reason: string }>;
  };
}

async function storedSession(id = SESSION_ID) {
  const [row] = await testDb
    .select()
    .from(readingSessions)
    .where(eq(readingSessions.id, id));
  return row;
}

async function storedDay(localDate = '2026-10-19') {
  const [row] = await testDb
    .select()
    .from(dailyStats)
    .where(and(eq(dailyStats.userId, user.id), eq(dailyStats.localDate, localDate)));
  return row;
}

it('applies a session and aggregates its local day', async () => {
  const result = await push(sessionChange());

  expect(result.applied).toHaveLength(1);
  expect(await storedSession()).toMatchObject({
    userId: user.id,
    bookId,
    activeSeconds: 600,
    pagesRead: 4,
  });
  expect(await storedDay()).toMatchObject({ activeSeconds: 600, qualified: true });
});

it('treats an identical replay as a skip and never doubles the day', async () => {
  await push(sessionChange());
  const replay = await push(sessionChange());

  expect(replay.applied).toHaveLength(0);
  expect(replay.skipped).toEqual([syncKey('reading_session', SESSION_ID)]);
  expect((await storedDay())?.activeSeconds).toBe(600);
});

it('accepts a growing heartbeat and replaces the day instead of adding to it', async () => {
  await push(sessionChange());
  const result = await push(
    sessionChange({
      clientUpdatedAt: '2026-10-19T02:21:00.000Z',
      endedAt: '2026-10-19T02:20:00.000Z',
      activeSeconds: 1_200,
    }),
  );

  expect(result.applied).toHaveLength(1);
  expect((await storedSession())?.activeSeconds).toBe(1_200);
  expect((await storedDay())?.activeSeconds).toBe(1_200);
});

it('refuses a newer heartbeat that would shrink the recorded time', async () => {
  await push(sessionChange());
  const result = await push(
    sessionChange({
      clientUpdatedAt: '2026-10-19T02:21:00.000Z',
      endedAt: '2026-10-19T02:20:00.000Z',
      activeSeconds: 300,
    }),
  );

  expect(result.applied).toHaveLength(0);
  expect(result.skipped).toEqual([syncKey('reading_session', SESSION_ID)]);
  expect((await storedSession())?.activeSeconds).toBe(600);
  expect((await storedDay())?.activeSeconds).toBe(600);
});

it('rejects malformed sessions', async () => {
  const cases = [
    sessionChange({ endedAt: '2026-10-19T01:59:00.000Z' }),
    sessionChange({ endedAt: '2026-10-20T02:01:00.000Z', activeSeconds: 600 }),
    sessionChange({ activeSeconds: 700 }),
    sessionChange({ pagesRead: 100_001 }),
  ];
  for (const change of cases) {
    const result = await push(change);
    expect(result.rejected[0]?.reason).toBe('invalid_payload');
  }
  expect(await storedSession()).toBeUndefined();
});

it('rejects a malformed session id without a database error', async () => {
  const result = await push(sessionChange({ id: 'not-a-uuid' }));
  expect(result.rejected[0]?.reason).toBe('invalid_payload');
});

it('rejects sessions for an unknown or trashed book', async () => {
  const unknown = await push(sessionChange({ book: newId() }));
  expect(unknown.rejected[0]?.reason).toBe('unknown_entity');

  const trashed = await seedBook({
    uploadedBy: user.id,
    deletedAt: new Date('2026-10-01T00:00:00.000Z'),
  });
  const deleted = await push(sessionChange({ book: trashed.id }));
  expect(deleted.rejected[0]?.reason).toBe('unknown_entity');
});

it('does not let one user overwrite another user session with the same id', async () => {
  const other = await seedUser('member');
  await testDb.insert(readingSessions).values({
    id: SESSION_ID,
    userId: other.id,
    bookId,
    startedAt: new Date(STARTED),
    endedAt: new Date(ENDED),
    activeSeconds: 300,
    pagesRead: 1,
    clientUpdatedAt: new Date(CLIENT_TIME),
    updatedAt: new Date(CLIENT_TIME),
  });

  const result = await push(sessionChange());
  expect(result.rejected[0]?.reason).toBe('not_allowed');
  expect((await storedSession())?.userId).toBe(other.id);
  expect((await storedSession())?.activeSeconds).toBe(300);
});

it('rejects delete because sessions are append-only', async () => {
  await push(sessionChange());
  const result = await push(sessionChange({ op: 'delete' }));
  expect(result.rejected[0]?.reason).toBe('unsupported_op');
  expect(await storedSession()).toBeDefined();
});
