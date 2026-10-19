import {
  ALERT_EVENTS_LIMIT,
  BACKUP_REPORTS_LIMIT,
  type BackupHeartbeatInput,
  type BackupReportDto,
  type BackupStatusDto,
} from '@bookr/shared';
import type { AppDeps } from '../app';
import { notifyConditionOnce } from '../monitor/notify';
import {
  findLatestReportBySource,
  findLatestReportWithDisk,
  findLatestSuccess,
  insertBackupReport,
  listRecentAlertEvents,
  listRecentReports,
  toAlertEventDto,
  toBackupReportDto,
} from './repo';

const HOUR_MS = 60 * 60 * 1000;

/**
 * Stores one heartbeat and returns the stored shape. A failed run raises the
 * `backup-failure` alert immediately, without delaying the 201 response; the
 * shared state machine keeps it from repeating inside the same incident.
 */
export async function recordBackupReport(
  deps: AppDeps,
  input: BackupHeartbeatInput,
): Promise<BackupReportDto> {
  const receivedAt = deps.clock.now();
  const row = await insertBackupReport(
    deps.db,
    {
      source: input.source,
      status: input.status,
      startedAt: new Date(input.startedAt),
      finishedAt: new Date(input.finishedAt),
      bytes: input.bytes ?? null,
      diskFreeBytes: input.diskFreeBytes ?? null,
      diskTotalBytes: input.diskTotalBytes ?? null,
      message: input.message ?? null,
    },
    receivedAt,
  );

  if (input.status === 'failure') {
    // The promise is deliberately detached: a slow webhook must not keep the
    // backup host waiting. `notifyConditionOnce` never rejects, and the extra
    // catch guards against future changes there.
    void notifyConditionOnce(
      deps,
      {
        key: 'backup-failure',
        severity: 'critical',
        message: `备份失败（来源：${input.source}）`,
      },
      receivedAt,
    ).catch(() => undefined);
  }

  return toBackupReportDto(row);
}

/**
 * Summarises backup health from the stored reports. Staleness is measured
 * from the last successful run's completion time; the backup PC's silence is
 * measured from when its latest heartbeat arrived, so a machine that stopped
 * reporting is caught even while server exports keep succeeding.
 */
export async function getBackupStatus(
  deps: AppDeps,
  now: Date = deps.clock.now(),
): Promise<BackupStatusDto> {
  const [reports, alerts, latestSuccess, latestServerExport, latestBackupPc, latestDisk] =
    await Promise.all([
      listRecentReports(deps.db, BACKUP_REPORTS_LIMIT),
      listRecentAlertEvents(deps.db, ALERT_EVENTS_LIMIT),
      findLatestSuccess(deps.db),
      findLatestReportBySource(deps.db, 'server-export'),
      findLatestReportBySource(deps.db, 'backup-pc'),
      findLatestReportWithDisk(deps.db),
    ]);

  const staleMs = deps.config.alerts.staleHours * HOUR_MS;
  const olderThanWindow = (at: Date): boolean => now.getTime() - at.getTime() > staleMs;

  const lastSuccessAt = latestSuccess?.finishedAt ?? null;
  const lastBackupPcAt = latestBackupPc?.receivedAt ?? null;
  // A heartbeat that arrived now but describes a run older than the window
  // still leaves the PC without recent proof of a completed backup.
  const backupPcSilent =
    latestBackupPc === undefined ||
    lastBackupPcAt === null ||
    olderThanWindow(lastBackupPcAt) ||
    olderThanWindow(latestBackupPc.finishedAt);

  const diskFreeBytes = latestDisk?.diskFreeBytes ?? null;
  const diskTotalBytes = latestDisk?.diskTotalBytes ?? null;

  return {
    lastSuccessAt: lastSuccessAt?.toISOString() ?? null,
    lastServerExportAt: latestServerExport?.receivedAt.toISOString() ?? null,
    lastBackupPcAt: lastBackupPcAt?.toISOString() ?? null,
    backupStale: lastSuccessAt === null || olderThanWindow(lastSuccessAt),
    backupPcSilent,
    diskFreeBytes,
    diskTotalBytes,
    diskLow:
      diskFreeBytes !== null &&
      diskFreeBytes < deps.config.alerts.diskFreeThresholdBytes,
    reports: reports.map(toBackupReportDto),
    alerts: alerts.map(toAlertEventDto),
  };
}
