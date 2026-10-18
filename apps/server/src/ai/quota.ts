import { ERROR_CODES } from '@bookr/shared';
import { and, eq, or, sql } from 'drizzle-orm';
import type { Database, Transaction } from '../db/client';
import { aiUsage, users, type AiUsagePeriod, type AiUsageRow } from '../db/schema';
import { AppError } from '../errors';
import type { AiTokenUsage } from './types';

/** Token ceilings applied to both quota windows. */
export interface QuotaLimits {
  daily: number;
  monthly: number;
}

/** Used, currently reserved and allowed tokens for one window. */
export interface AiQuotaWindow {
  used: number;
  reserved: number;
  limit: number;
}

/** The daily and monthly windows for one user at one instant. */
export interface QuotaSnapshot {
  daily: AiQuotaWindow;
  monthly: AiQuotaWindow;
}

/** Everything needed to reserve tokens for one request. */
export interface QuotaReserveInput {
  userId: string;
  timezone: string;
  estimate: number;
  limits: QuotaLimits;
  now: Date;
}

/** Tokens held for one request until it settles or is released. */
export interface QuotaReservation {
  userId: string;
  daily: { periodStart: string; estimate: number };
  monthly: { periodStart: string; estimate: number };
}

type QuotaWindowInput = Omit<QuotaReserveInput, 'estimate'>;

const DAY_FORMAT_OPTIONS: Intl.DateTimeFormatOptions = {
  timeZone: 'UTC',
  year: 'numeric',
  month: '2-digit',
  day: '2-digit',
};

function formatterFor(timezone: string): Intl.DateTimeFormat {
  const candidate = timezone?.trim();
  try {
    return new Intl.DateTimeFormat('en-US', {
      ...DAY_FORMAT_OPTIONS,
      timeZone: candidate ? candidate : 'UTC',
    });
  } catch {
    // An unknown IANA zone must not break quota accounting; fall back to UTC.
    return new Intl.DateTimeFormat('en-US', DAY_FORMAT_OPTIONS);
  }
}

/** Local `YYYY-MM-DD` and `YYYY-MM` keys for a user, tolerating invalid zones. */
export function periodKeys(now: Date, timezone: string): { day: string; month: string } {
  const parts = formatterFor(timezone).formatToParts(now);
  const part = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((entry) => entry.type === type)?.value ?? '';
  const day = `${part('year')}-${part('month')}-${part('day')}`;
  return { day, month: day.slice(0, 7) };
}

/** Coerces database and caller values to a non-negative integer. */
function safeInt(value: unknown): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 0;
  }
  return Math.max(0, Math.trunc(number));
}

function estimateTokens(value: number): number {
  const number = Number(value);
  if (!Number.isFinite(number)) {
    return 1;
  }
  return Math.max(1, Math.ceil(number));
}

function windowSnapshot(row: AiUsageRow | undefined, limit: number): AiQuotaWindow {
  return {
    used: safeInt(row?.promptTokens) + safeInt(row?.completionTokens),
    reserved: safeInt(row?.reservedTokens),
    limit: safeInt(limit),
  };
}

async function selectWindows(
  db: Database | Transaction,
  userId: string,
  day: string,
  month: string,
): Promise<AiUsageRow[]> {
  return db
    .select()
    .from(aiUsage)
    .where(
      and(
        eq(aiUsage.userId, userId),
        or(
          and(eq(aiUsage.period, 'day'), eq(aiUsage.periodStart, day)),
          and(eq(aiUsage.period, 'month'), eq(aiUsage.periodStart, month)),
        ),
      ),
    );
}

function pickWindow(
  rows: AiUsageRow[],
  period: AiUsagePeriod,
  periodStart: string,
): AiUsageRow | undefined {
  return rows.find((row) => row.period === period && row.periodStart === periodStart);
}

/** Reads the current windows without reserving anything. */
export async function readQuota(db: Database, input: QuotaWindowInput): Promise<QuotaSnapshot> {
  const { day, month } = periodKeys(input.now, input.timezone);
  const rows = await selectWindows(db, input.userId, day, month);
  return {
    daily: windowSnapshot(pickWindow(rows, 'day', day), input.limits.daily),
    monthly: windowSnapshot(pickWindow(rows, 'month', month), input.limits.monthly),
  };
}

async function reserveWindow(
  tx: Transaction,
  userId: string,
  period: AiUsagePeriod,
  periodStart: string,
  estimate: number,
  now: Date,
): Promise<AiUsageRow> {
  const [row] = await tx
    .insert(aiUsage)
    .values({
      userId,
      period,
      periodStart,
      promptTokens: 0,
      completionTokens: 0,
      reservedTokens: estimate,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: [aiUsage.userId, aiUsage.period, aiUsage.periodStart],
      set: {
        reservedTokens: sql`${aiUsage.reservedTokens} + ${estimate}`,
        updatedAt: now,
      },
    })
    .returning();
  if (!row) {
    throw new Error('reserveQuota could not upsert an ai_usage window');
  }
  return row;
}

/**
 * Holds `estimate` tokens in both windows, serialised per user with an advisory
 * transaction lock, and rolls the whole reservation back when either window
 * would exceed its limit.
 */
export async function reserveQuota(
  db: Database,
  input: QuotaReserveInput,
): Promise<QuotaReservation> {
  const estimate = estimateTokens(input.estimate);
  const { day, month } = periodKeys(input.now, input.timezone);
  const daily = { periodStart: day, estimate };
  const monthly = { periodStart: month, estimate };
  const lockKey = `ai-quota:${input.userId}`;

  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`);

    const dailyRow = await reserveWindow(tx, input.userId, 'day', day, estimate, input.now);
    const monthlyRow = await reserveWindow(tx, input.userId, 'month', month, estimate, input.now);
    const snapshot: QuotaSnapshot = {
      daily: windowSnapshot(dailyRow, input.limits.daily),
      monthly: windowSnapshot(monthlyRow, input.limits.monthly),
    };

    if (
      snapshot.daily.used + snapshot.daily.reserved > snapshot.daily.limit ||
      snapshot.monthly.used + snapshot.monthly.reserved > snapshot.monthly.limit
    ) {
      throw new AppError(429, ERROR_CODES.AI_QUOTA_EXCEEDED, {
        daily: snapshot.daily,
        monthly: snapshot.monthly,
      });
    }
  });

  return { userId: input.userId, daily, monthly };
}

async function settleWindow(
  tx: Transaction,
  userId: string,
  period: AiUsagePeriod,
  periodStart: string,
  estimate: number,
  promptTokens: number,
  completionTokens: number,
  now: Date,
): Promise<void> {
  await tx
    .update(aiUsage)
    .set({
      reservedTokens: sql`greatest(${aiUsage.reservedTokens} - ${estimate}, 0)`,
      promptTokens: sql`${aiUsage.promptTokens} + ${promptTokens}`,
      completionTokens: sql`${aiUsage.completionTokens} + ${completionTokens}`,
      updatedAt: now,
    })
    .where(
      and(
        eq(aiUsage.userId, userId),
        eq(aiUsage.period, period),
        eq(aiUsage.periodStart, periodStart),
      ),
    );
}

/**
 * Swaps the held estimate for the tokens actually consumed. Any surplus hold is
 * dropped, so a provider error can be released with zero actual usage.
 * The returned snapshot reads its limits from the user's `ai_*_token_limit` columns.
 */
export async function settleQuota(
  db: Database,
  reservation: QuotaReservation,
  actual: AiTokenUsage,
  now: Date,
): Promise<QuotaSnapshot> {
  const promptTokens = safeInt(actual.promptTokens);
  const completionTokens = safeInt(actual.completionTokens);

  return db.transaction(async (tx) => {
    await settleWindow(
      tx,
      reservation.userId,
      'day',
      reservation.daily.periodStart,
      reservation.daily.estimate,
      promptTokens,
      completionTokens,
      now,
    );
    await settleWindow(
      tx,
      reservation.userId,
      'month',
      reservation.monthly.periodStart,
      reservation.monthly.estimate,
      promptTokens,
      completionTokens,
      now,
    );

    const [limits] = await tx
      .select({ daily: users.aiDailyTokenLimit, monthly: users.aiMonthlyTokenLimit })
      .from(users)
      .where(eq(users.id, reservation.userId))
      .limit(1);
    const rows = await selectWindows(
      tx,
      reservation.userId,
      reservation.daily.periodStart,
      reservation.monthly.periodStart,
    );
    return {
      daily: windowSnapshot(
        pickWindow(rows, 'day', reservation.daily.periodStart),
        limits?.daily ?? 0,
      ),
      monthly: windowSnapshot(
        pickWindow(rows, 'month', reservation.monthly.periodStart),
        limits?.monthly ?? 0,
      ),
    };
  });
}

/** Drops a reservation without recording usage. */
export function releaseQuota(
  db: Database,
  reservation: QuotaReservation,
  now: Date,
): Promise<QuotaSnapshot> {
  return settleQuota(db, reservation, { promptTokens: 0, completionTokens: 0 }, now);
}
