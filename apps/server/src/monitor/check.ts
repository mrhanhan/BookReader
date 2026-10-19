import { BACKUP_STALE_HOURS, type BackupStatusDto } from '@bookr/shared';
import type { AppDeps } from '../app';
import { deactivateMonitorState } from '../backup/repo';
import { getBackupStatus } from '../backup/service';
import type { AppConfig } from '../config';
import { notifyConditionOnce, type AlertCondition, type AlertKey } from './notify';

/** Every condition the monitor tracks, including ones that are currently false. */
export const MONITORED_ALERT_KEYS: readonly AlertKey[] = [
  'backup-stale',
  'backup-pc-silent',
  'disk-low',
  'backup-failure',
];

/** A fresh failure keeps alerting for this long after it was reported. */
const FAILURE_RECENCY_MS = BACKUP_STALE_HOURS * 60 * 60 * 1000;

function hoursBetween(from: Date, to: Date): number {
  return Math.max(0, Math.floor((to.getTime() - from.getTime()) / (60 * 60 * 1000)));
}

/** Translates a status snapshot into the conditions that are currently true. */
export function evaluateAlerts(
  status: BackupStatusDto,
  config: AppConfig,
  now: Date,
): AlertCondition[] {
  const conditions: AlertCondition[] = [];

  if (status.backupStale) {
    conditions.push({
      key: 'backup-stale',
      severity: 'critical',
      message:
        status.lastSuccessAt === null
          ? '尚无成功的备份记录'
          : `备份已 ${hoursBetween(new Date(status.lastSuccessAt), now)} 小时未成功`,
    });
  }

  if (status.backupPcSilent) {
    conditions.push({
      key: 'backup-pc-silent',
      severity: 'warning',
      message: `备份机已超过 ${config.alerts.staleHours} 小时未上报`,
    });
  }

  if (status.diskLow) {
    const gib = Math.max(1, Math.round(config.alerts.diskFreeThresholdBytes / 1024 ** 3));
    conditions.push({
      key: 'disk-low',
      severity: 'warning',
      message: `磁盘可用空间低于 ${gib} GiB 阈值`,
    });
  }

  const latest = status.reports[0];
  if (
    latest !== undefined &&
    latest.status === 'failure' &&
    now.getTime() - Date.parse(latest.receivedAt) <= FAILURE_RECENCY_MS
  ) {
    conditions.push({
      key: 'backup-failure',
      severity: 'critical',
      message: `最近一次备份失败（来源：${latest.source}）`,
    });
  }

  return conditions;
}

/**
 * One monitor pass: read health, raise each true condition through the shared
 * state machine, and clear conditions that no longer hold so a later relapse
 * alerts again.
 */
export async function runMonitorTick(
  deps: AppDeps,
  now: Date = deps.clock.now(),
): Promise<AlertCondition[]> {
  // Everything this tick evaluates belongs to the instant it started. Alerts
  // raised later (for example by a failing heartbeat) must survive the
  // recovery sweep below.
  const tickStart = now;
  const status = await getBackupStatus(deps, now);
  const conditions = evaluateAlerts(status, deps.config, now);
  const activeKeys = new Set(conditions.map((condition) => condition.key));

  for (const condition of conditions) {
    await notifyConditionOnce(deps, condition, now);
  }
  for (const key of MONITORED_ALERT_KEYS) {
    if (!activeKeys.has(key)) {
      await deactivateMonitorState(deps.db, key, tickStart, now);
    }
  }

  return conditions;
}
