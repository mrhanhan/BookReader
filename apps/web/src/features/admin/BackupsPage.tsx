import { Button, cn } from '@bookr/ui';
import type { AlertEventDto, BackupReportDto, BackupStatusDto } from '@bookr/shared';
import { useBackupStatus } from '../../api/admin';
import { messageForApiError } from '../../lib/errorMessages';
import { formatBytes, formatDateTime } from '../../lib/format';
import { AdminTabs } from './AdminTabs';

const alertClass =
  'rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight';
const cardClass = 'rounded-lg border border-border bg-surface/70 p-4';
const cellClass = 'px-4 py-3 align-top';

const SOURCE_LABELS: Record<BackupReportDto['source'], string> = {
  'server-export': '服务器导出',
  'backup-pc': '备份机',
};

const STATUS_LABELS: Record<BackupReportDto['status'], string> = {
  success: '成功',
  failure: '失败',
};

const ALERT_STATUS_LABELS: Record<AlertEventDto['status'], string> = {
  sent: '已发送',
  failed: '发送失败',
};

function StatusCard({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className={cardClass}>
      <p className="text-xs tracking-widest text-muted">{label}</p>
      <p className="mt-1 text-lg tabular-nums text-ink">{value}</p>
      {detail ? <p className="mt-0.5 text-xs text-muted">{detail}</p> : null}
    </div>
  );
}

/** Disk line for the third card; unknown totals stay readable. */
function diskDetail(status: BackupStatusDto): string | undefined {
  if (status.diskFreeBytes === null || status.diskTotalBytes === null) return undefined;
  return `共 ${formatBytes(status.diskTotalBytes)}`;
}

function BackupStatusCards({ status }: { status: BackupStatusDto }) {
  return (
    <div className="grid gap-3 sm:grid-cols-3">
      <StatusCard
        label="最近成功备份"
        value={status.lastSuccessAt ? formatDateTime(status.lastSuccessAt) : '尚无记录'}
        detail={status.lastSuccessAt ? undefined : '等待第一次服务器备份'}
      />
      <StatusCard
        label="备份机最近上报"
        value={status.lastBackupPcAt ? formatDateTime(status.lastBackupPcAt) : '尚无上报'}
        detail={status.lastBackupPcAt ? undefined : '备份机尚未连接'}
      />
      <StatusCard
        label="磁盘可用"
        value={status.diskFreeBytes === null ? '未知' : formatBytes(status.diskFreeBytes)}
        detail={diskDetail(status)}
      />
    </div>
  );
}

function BackupWarnings({ status }: { status: BackupStatusDto }) {
  const warnings: string[] = [];
  if (status.backupStale) warnings.push('备份已超过设定时长未成功，请检查备份机与脚本');
  if (status.backupPcSilent) warnings.push('备份机已超过设定时长未上报，请检查备份机与网络');
  if (status.diskLow) warnings.push('磁盘可用空间低于阈值');

  if (warnings.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      {warnings.map((warning) => (
        <p key={warning} role="alert" className={alertClass}>
          {warning}
        </p>
      ))}
    </div>
  );
}

function ReportTable({ reports }: { reports: BackupReportDto[] }) {
  if (reports.length === 0) {
    return (
      <p className="rounded-lg border border-dashed border-border bg-surface/60 px-4 py-8 text-center text-sm text-muted">
        尚无备份记录，请先运行服务器备份脚本
      </p>
    );
  }

  return (
    <div className="overflow-x-auto rounded-lg border border-border bg-surface/70">
      <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
        <caption className="sr-only">备份记录</caption>
        <thead>
          <tr className="text-xs tracking-widest text-muted">
            <th scope="col" className={cellClass}>时间</th>
            <th scope="col" className={cellClass}>来源</th>
            <th scope="col" className={cellClass}>状态</th>
            <th scope="col" className={cellClass}>大小</th>
            <th scope="col" className={cellClass}>说明</th>
          </tr>
        </thead>
        <tbody>
          {reports.map((report) => (
            <tr key={report.id} className="border-t border-border first:border-t-0">
              <td className={cn(cellClass, 'whitespace-nowrap text-xs tabular-nums text-muted')}>
                {formatDateTime(report.finishedAt)}
              </td>
              <td className={cn(cellClass, 'text-ink')}>{SOURCE_LABELS[report.source]}</td>
              <td
                className={cn(
                  cellClass,
                  report.status === 'success' ? 'text-accent' : 'text-highlight',
                )}
              >
                {STATUS_LABELS[report.status]}
              </td>
              <td className={cn(cellClass, 'whitespace-nowrap text-xs tabular-nums text-muted')}>
                {report.bytes === null ? '—' : formatBytes(report.bytes)}
              </td>
              <td className={cn(cellClass, 'text-xs text-muted')}>
                {report.message ?? '—'}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function AlertHistory({ alerts }: { alerts: AlertEventDto[] }) {
  if (alerts.length === 0) {
    return <p className="text-sm text-muted">暂无告警记录</p>;
  }

  return (
    <ul className="divide-y divide-border rounded-lg border border-border bg-surface/70">
      {alerts.slice(0, 10).map((alert) => (
        <li key={alert.id} className="flex flex-wrap items-baseline gap-x-3 gap-y-1 px-4 py-3">
          <span className="text-sm text-ink">{alert.message}</span>
          <span
            className={cn(
              'text-xs',
              alert.status === 'sent' ? 'text-accent' : 'text-highlight',
            )}
          >
            {ALERT_STATUS_LABELS[alert.status]}
          </span>
          <span className="ml-auto text-xs tabular-nums text-muted">
            {formatDateTime(alert.sentAt)}
          </span>
          {alert.error ? (
            <span className="basis-full text-xs text-highlight">{alert.error}</span>
          ) : null}
        </li>
      ))}
    </ul>
  );
}

/** Backup health, the latest heartbeat ledger and alert delivery history. */
export function BackupsPage() {
  const statusQuery = useBackupStatus();

  return (
    <section className="flex flex-col gap-6">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <h1 className="font-serif text-2xl text-ink">备份与告警</h1>
          <p className="mt-1 text-sm text-muted">服务器导出与备份机心跳的最近状态。</p>
        </div>
        <Button variant="ghost" size="sm" onClick={() => statusQuery.refetch()}>
          刷新
        </Button>
      </div>

      <AdminTabs />

      {statusQuery.isPending ? (
        <p role="status" className="py-10 text-center text-sm tracking-widest text-muted">
          正在读取备份状态…
        </p>
      ) : statusQuery.isError ? (
        <div role="alert" className={cn(alertClass, 'flex flex-wrap items-center gap-3')}>
          <span>{messageForApiError(statusQuery.error)}</span>
          <Button variant="ghost" size="sm" onClick={() => statusQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : (
        <>
          <BackupStatusCards status={statusQuery.data} />
          <BackupWarnings status={statusQuery.data} />

          <section aria-labelledby="backup-reports-title" className="flex flex-col gap-3">
            <h2 id="backup-reports-title" className="font-serif text-lg text-ink">
              备份记录
            </h2>
            <ReportTable reports={statusQuery.data.reports} />
          </section>

          <section aria-labelledby="backup-alerts-title" className="flex flex-col gap-3">
            <h2 id="backup-alerts-title" className="font-serif text-lg text-ink">
              告警历史
            </h2>
            <AlertHistory alerts={statusQuery.data.alerts} />
          </section>
        </>
      )}
    </section>
  );
}
