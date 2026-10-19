import {
  type AlertEventDto,
  type BackupReportDto,
  type BackupReportStatus,
  type BackupSource,
} from '@bookr/shared';
import { and, desc, eq, isNotNull, isNull, lt, or } from 'drizzle-orm';
import type { Database } from '../db/client';
import { alertEvents, backupReports, monitorStates } from '../db/schema';

export type BackupReportRow = typeof backupReports.$inferSelect;
export type AlertEventRow = typeof alertEvents.$inferSelect;
export type MonitorStateRow = typeof monitorStates.$inferSelect;

/** Values stored for one heartbeat; timestamps are already parsed. */
export interface NewBackupReport {
  source: BackupSource;
  status: BackupReportStatus;
  startedAt: Date;
  finishedAt: Date;
  bytes: number | null;
  diskFreeBytes: number | null;
  diskTotalBytes: number | null;
  message: string | null;
}

/** Inserts a heartbeat with the caller-supplied receipt time. */
export async function insertBackupReport(
  db: Database,
  report: NewBackupReport,
  receivedAt: Date,
): Promise<BackupReportRow> {
  const [row] = await db
    .insert(backupReports)
    .values({ ...report, receivedAt })
    .returning();
  if (!row) {
    throw new Error('Backup report insert returned no row');
  }
  return row;
}

/** Latest reports first, bounded by the status endpoint limit. */
export async function listRecentReports(
  db: Database,
  limit: number,
): Promise<BackupReportRow[]> {
  return db
    .select()
    .from(backupReports)
    .orderBy(desc(backupReports.receivedAt), desc(backupReports.id))
    .limit(limit);
}

/** Most recent successful run across both sources, ordered by completion. */
export async function findLatestSuccess(db: Database): Promise<BackupReportRow | undefined> {
  const [row] = await db
    .select()
    .from(backupReports)
    .where(eq(backupReports.status, 'success'))
    .orderBy(desc(backupReports.finishedAt), desc(backupReports.receivedAt))
    .limit(1);
  return row;
}

/** Most recently received report from one source, whatever its result. */
export async function findLatestReportBySource(
  db: Database,
  source: BackupSource,
): Promise<BackupReportRow | undefined> {
  const [row] = await db
    .select()
    .from(backupReports)
    .where(eq(backupReports.source, source))
    .orderBy(desc(backupReports.receivedAt), desc(backupReports.id))
    .limit(1);
  return row;
}

/** Most recently received report that carried disk capacity numbers. */
export async function findLatestReportWithDisk(
  db: Database,
): Promise<BackupReportRow | undefined> {
  const [row] = await db
    .select()
    .from(backupReports)
    .where(isNotNull(backupReports.diskFreeBytes))
    .orderBy(desc(backupReports.receivedAt), desc(backupReports.id))
    .limit(1);
  return row;
}

/** Most recently received report, used to spot a fresh failure. */
export async function findLatestReport(db: Database): Promise<BackupReportRow | undefined> {
  const [row] = await db
    .select()
    .from(backupReports)
    .orderBy(desc(backupReports.receivedAt), desc(backupReports.id))
    .limit(1);
  return row;
}

/** Latest alert delivery attempts first. */
export async function listRecentAlertEvents(
  db: Database,
  limit: number,
): Promise<AlertEventRow[]> {
  return db
    .select()
    .from(alertEvents)
    .orderBy(desc(alertEvents.sentAt), desc(alertEvents.id))
    .limit(limit);
}

/** Reads the alert state machine row for one condition key. */
export async function readMonitorState(
  db: Database,
  key: string,
): Promise<MonitorStateRow | undefined> {
  const [row] = await db
    .select()
    .from(monitorStates)
    .where(eq(monitorStates.key, key))
    .limit(1);
  return row;
}

/** Values written whenever a condition is observed. */
export interface MonitorStateUpdate {
  key: string;
  active: boolean;
  /** Omitted on failed deliveries so the previous window is preserved. */
  lastAlertAt?: Date | null;
  updatedAt: Date;
}

/** Creates or updates a state row without touching fields that are omitted. */
export async function upsertMonitorState(
  db: Database,
  state: MonitorStateUpdate,
): Promise<void> {
  await db
    .insert(monitorStates)
    .values({
      key: state.key,
      active: state.active,
      lastAlertAt: state.lastAlertAt ?? null,
      updatedAt: state.updatedAt,
    })
    .onConflictDoUpdate({
      target: monitorStates.key,
      set: {
        active: state.active,
        updatedAt: state.updatedAt,
        ...(state.lastAlertAt !== undefined ? { lastAlertAt: state.lastAlertAt } : {}),
      },
    });
}

/**
 * Atomically claims the alert window for one condition. The `ON CONFLICT`
 * update only fires while the condition is inactive, has never been delivered,
 * or the repeat window has elapsed, so concurrent ticks cannot both deliver.
 * Returns `false` when another caller (or an earlier tick) holds the window.
 */
export async function claimAlertWindow(
  db: Database,
  key: string,
  now: Date,
  cutoff: Date,
): Promise<boolean> {
  const [row] = await db
    .insert(monitorStates)
    .values({ key, active: true, lastAlertAt: now, updatedAt: now })
    .onConflictDoUpdate({
      target: monitorStates.key,
      set: { active: true, lastAlertAt: now, updatedAt: now },
      setWhere: or(
        eq(monitorStates.active, false),
        isNull(monitorStates.lastAlertAt),
        lt(monitorStates.lastAlertAt, cutoff),
      ),
    })
    .returning({ key: monitorStates.key });
  return row !== undefined;
}

/**
 * Rolls a failed delivery back to "inactive" so the next tick retries. The
 * update is scoped to the attempt's timestamp so a newer claim is untouched.
 */
export async function releaseAlertClaim(
  db: Database,
  key: string,
  claimedAt: Date,
  updatedAt: Date,
): Promise<void> {
  await db
    .update(monitorStates)
    .set({ active: false, updatedAt })
    .where(and(eq(monitorStates.key, key), eq(monitorStates.lastAlertAt, claimedAt)));
}

/**
 * Marks a recovered condition inactive, keeping `lastAlertAt` for history.
 * Alerts raised after the tick began are left alone: the immediate alert from
 * a fresh failure heartbeat must not be cleared by a stale status snapshot.
 */
export async function deactivateMonitorState(
  db: Database,
  key: string,
  tickStart: Date,
  updatedAt: Date,
): Promise<void> {
  await db
    .update(monitorStates)
    .set({ active: false, updatedAt })
    .where(
      and(
        eq(monitorStates.key, key),
        eq(monitorStates.active, true),
        or(
          isNull(monitorStates.lastAlertAt),
          lt(monitorStates.lastAlertAt, tickStart),
        ),
      ),
    );
}

/** One webhook delivery attempt. */
export interface NewAlertEvent {
  key: string;
  severity: 'warning' | 'critical';
  message: string;
  status: 'sent' | 'failed';
  error: string | null;
  sentAt: Date;
}

/** Records the outcome of an alert delivery attempt. */
export async function insertAlertEvent(
  db: Database,
  event: NewAlertEvent,
): Promise<void> {
  await db.insert(alertEvents).values(event);
}

/** Maps a stored report onto the public contract. */
export function toBackupReportDto(row: BackupReportRow): BackupReportDto {
  return {
    id: row.id,
    source: row.source as BackupSource,
    status: row.status as BackupReportStatus,
    startedAt: row.startedAt.toISOString(),
    finishedAt: row.finishedAt.toISOString(),
    bytes: row.bytes,
    diskFreeBytes: row.diskFreeBytes,
    diskTotalBytes: row.diskTotalBytes,
    message: row.message,
    receivedAt: row.receivedAt.toISOString(),
  };
}

/** Maps a stored alert attempt onto the public contract. */
export function toAlertEventDto(row: AlertEventRow): AlertEventDto {
  return {
    id: row.id,
    key: row.key,
    severity: row.severity as AlertEventDto['severity'],
    message: row.message,
    sentAt: row.sentAt.toISOString(),
    status: row.status as AlertEventDto['status'],
    error: row.error,
  };
}
