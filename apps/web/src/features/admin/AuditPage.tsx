import { useState } from 'react';
import { Button, EmptyState, cn } from '@bookr/ui';
import { useAuditLog } from '../../api/admin';
import { messageForApiError } from '../../lib/errorMessages';
import { formatDateTime } from '../../lib/format';
import { AdminTabs } from './AdminTabs';

/** Rows requested per audit page; the API caps the value at 100. */
const AUDIT_PAGE_SIZE = 20;

/** Characters of serialized metadata shown before truncation. */
const METADATA_PREVIEW_LENGTH = 120;

const alertClass =
  'rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight';
const cellClass = 'px-4 py-3 align-top';

/** Human-readable action labels; unknown actions keep their raw name. */
const ACTION_LABELS: Record<string, string> = {
  'auth.login': '登录',
  'auth.register': '注册',
  'book.delete': '删除图书',
  'admin.member.update': '修改成员',
  'admin.invite.create': '创建邀请码',
  'admin.invite.revoke': '撤销邀请码',
  'admin.settings.update': '修改系统设置',
  'ai.config.update': '更新 AI 配置',
};

function actionLabel(action: string): string {
  return ACTION_LABELS[action] ?? action;
}

/** Truncated metadata plus the full JSON for the tooltip/title. */
function metadataPreview(metadata: Record<string, unknown> | null) {
  if (!metadata) return null;
  const full = JSON.stringify(metadata);
  const text =
    full.length > METADATA_PREVIEW_LENGTH
      ? `${full.slice(0, METADATA_PREVIEW_LENGTH)}…`
      : full;
  return { text, full };
}

/** Read-only ledger of administrative and account events. */
export function AuditPage() {
  const [page, setPage] = useState(1);
  const auditQuery = useAuditLog(page, AUDIT_PAGE_SIZE);
  const data = auditQuery.data;
  const totalPages = Math.max(1, Math.ceil((data?.total ?? 0) / AUDIT_PAGE_SIZE));

  return (
    <section className="flex flex-col gap-6">
      <div>
        <h1 className="font-serif text-2xl text-ink">审计日志</h1>
        <p className="mt-1 text-sm text-muted">登录、图书、成员与系统设置的变更都记录在这里。</p>
      </div>

      <AdminTabs />

      {auditQuery.isPending ? (
        <p role="status" className="py-10 text-center text-sm tracking-widest text-muted">
          正在读取审计日志…
        </p>
      ) : auditQuery.isError ? (
        <div role="alert" className={cn(alertClass, 'flex flex-wrap items-center gap-3')}>
          <span>{messageForApiError(auditQuery.error)}</span>
          <Button variant="ghost" size="sm" onClick={() => auditQuery.refetch()}>
            重试
          </Button>
        </div>
      ) : !data ? (
        <p role="status" className="py-10 text-center text-sm tracking-widest text-muted">
          正在读取审计日志…
        </p>
      ) : data.items.length === 0 ? (
        <EmptyState title="还没有审计记录" description="成员登录和修改之后，记录会出现在这里。" />
      ) : (
        <>
          <div className="overflow-x-auto rounded-lg border border-border bg-surface/70">
            <table className="w-full min-w-[36rem] border-collapse text-left text-sm">
              <caption className="sr-only">审计日志</caption>
              <thead>
                <tr className="text-xs tracking-widest text-muted">
                  <th scope="col" className={cellClass}>
                    时间
                  </th>
                  <th scope="col" className={cellClass}>
                    成员
                  </th>
                  <th scope="col" className={cellClass}>
                    动作
                  </th>
                  <th scope="col" className={cellClass}>
                    对象
                  </th>
                </tr>
              </thead>
              <tbody>
                {data.items.map((entry) => {
                  const metadata = metadataPreview(entry.metadata);
                  return (
                    <tr key={entry.id} className="border-t border-border first:border-t-0">
                      <td className={cn(cellClass, 'whitespace-nowrap text-xs tabular-nums text-muted')}>
                        {formatDateTime(entry.createdAt)}
                      </td>
                      <td className={cn(cellClass, 'text-ink')}>
                        {entry.displayName ?? '系统'}
                      </td>
                      <td className={cn(cellClass, 'text-ink')}>{actionLabel(entry.action)}</td>
                      <td className={cellClass}>
                        <div className="flex min-w-0 flex-col gap-1">
                          <span className="break-words text-ink">{entry.target ?? '—'}</span>
                          {metadata ? (
                            <code
                              title={metadata.full}
                              className="break-all font-mono text-xs text-muted"
                            >
                              {metadata.text}
                            </code>
                          ) : null}
                        </div>
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="flex flex-wrap items-center gap-3">
            <Button
              variant="ghost"
              size="sm"
              disabled={page <= 1}
              onClick={() => setPage((current) => Math.max(1, current - 1))}
            >
              上一页
            </Button>
            <span className="text-sm tabular-nums text-muted">
              第 {page} / {totalPages} 页
            </span>
            <Button
              variant="ghost"
              size="sm"
              disabled={page >= totalPages}
              onClick={() => setPage((current) => Math.min(totalPages, current + 1))}
            >
              下一页
            </Button>
          </div>
        </>
      )}
    </section>
  );
}
