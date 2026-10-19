import { and, eq, gte, gt, lt } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import {
  books,
  dailyStats,
  readingSessions,
  users,
  type ReadingSessionRow,
} from '../db/schema';

/** Fields written by a reading-session upsert. */
export interface UpsertReadingSessionInput {
  id: string;
  userId: string;
  bookId: string;
  deviceId: string | null;
  startedAt: Date;
  endedAt: Date;
  activeSeconds: number;
  pagesRead: number;
  clientUpdatedAt: Date;
  updatedAt: Date;
}

/** Loads one session row under a row lock, or null when it does not exist yet. */
export async function findReadingSession(
  tx: Transaction,
  id: string,
): Promise<ReadingSessionRow | null> {
  const [row] = await tx
    .select()
    .from(readingSessions)
    .where(eq(readingSessions.id, id))
    .limit(1)
    .for('update');
  return row ?? null;
}

/** Inserts or updates one session; heartbeats rewrite the same id. */
export async function upsertReadingSession(
  tx: Transaction,
  input: UpsertReadingSessionInput,
): Promise<ReadingSessionRow> {
  const [row] = await tx
    .insert(readingSessions)
    .values({ ...input })
    .onConflictDoUpdate({
      target: readingSessions.id,
      set: {
        bookId: input.bookId,
        deviceId: input.deviceId,
        startedAt: input.startedAt,
        endedAt: input.endedAt,
        activeSeconds: input.activeSeconds,
        pagesRead: input.pagesRead,
        clientUpdatedAt: input.clientUpdatedAt,
        updatedAt: input.updatedAt,
      },
    })
    .returning();
  return row!;
}

/** The caller's statistics timezone; missing rows fall back to the default. */
export async function readUserTimezone(
  db: Database | Transaction,
  userId: string,
): Promise<string> {
  const [row] = await db
    .select({ timezone: users.timezone })
    .from(users)
    .where(eq(users.id, userId))
    .limit(1);
  return row?.timezone?.trim() || 'Asia/Shanghai';
}

/** Sessions overlapping `[from, to)`, which is all a day's aggregation needs. */
export async function listSessionsOverlapping(
  db: Database | Transaction,
  userId: string,
  from: Date,
  to: Date,
): Promise<ReadingSessionRow[]> {
  return db
    .select()
    .from(readingSessions)
    .where(
      and(
        eq(readingSessions.userId, userId),
        lt(readingSessions.startedAt, to),
        gte(readingSessions.endedAt, from),
      ),
    );
}

/** Every session of one user, used after a timezone change. */
export async function listAllSessions(
  db: Database | Transaction,
  userId: string,
): Promise<ReadingSessionRow[]> {
  return db.select().from(readingSessions).where(eq(readingSessions.userId, userId));
}

/** Replaces one aggregated day; the aggregate is derived, never incremented. */
export async function replaceDailyStat(
  tx: Transaction,
  input: {
    userId: string;
    localDate: string;
    activeSeconds: number;
    qualified: boolean;
    updatedAt: Date;
  },
): Promise<void> {
  await tx
    .insert(dailyStats)
    .values(input)
    .onConflictDoUpdate({
      target: [dailyStats.userId, dailyStats.localDate],
      set: {
        activeSeconds: input.activeSeconds,
        qualified: input.qualified,
        updatedAt: input.updatedAt,
      },
    });
}

/** Removes a day that no longer has any active seconds. */
export async function deleteDailyStat(
  tx: Transaction,
  userId: string,
  localDate: string,
): Promise<void> {
  await tx
    .delete(dailyStats)
    .where(and(eq(dailyStats.userId, userId), eq(dailyStats.localDate, localDate)));
}

/** Clears a user's aggregate before a full rebuild. */
export async function deleteAllDailyStats(tx: Transaction, userId: string): Promise<void> {
  await tx.delete(dailyStats).where(eq(dailyStats.userId, userId));
}

/** Users whose sessions belong to books about to be purged from the trash. */
export async function listSessionUserIdsForPurge(
  db: Database,
  cutoff: Date,
): Promise<string[]> {
  const rows = await db
    .selectDistinct({ userId: readingSessions.userId })
    .from(readingSessions)
    .innerJoin(books, eq(books.id, readingSessions.bookId))
    .where(lt(books.deletedAt, cutoff));
  return rows.map((row) => row.userId);
}
