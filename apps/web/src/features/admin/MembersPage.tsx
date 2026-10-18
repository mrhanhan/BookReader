import { useCallback, useEffect, useState } from 'react';
import { Button, Dialog, EmptyState, Input, cn } from '@bookr/ui';
import { useInvites, useMembers, useRevokeInvite, useStorageOverview, useUpdateMember } from '../../api/admin';
import type { AdminInvite, AdminMember } from '../../api/admin';
import { messageForApiError } from '../../lib/errorMessages';
import { formatBytes, formatDateTime } from '../../lib/format';
import { Toast } from '../bookshelf/Toast';
import { InviteDialog } from './InviteDialog';

/** A short, shared sentence for a failed administration request. */
const alertClass =
  'rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight';

const cellClass = 'px-4 py-3 align-middle';

function roleLabel(role: AdminMember['role']): string {
  return role === 'admin' ? '管理员' : '成员';
}

function inviteState(invite: AdminInvite): { label: string; className: string; canRevoke: boolean } {
  if (invite.revokedAt) {
    return { label: '已撤销', className: 'text-muted', canRevoke: false };
  }
  if (invite.usedBy) {
    return { label: '已使用', className: 'text-muted', canRevoke: false };
  }
  const expiresAt = new Date(invite.expiresAt).getTime();
  if (Number.isNaN(expiresAt) || expiresAt <= Date.now()) {
    return { label: '已过期', className: 'text-highlight', canRevoke: false };
  }
  return { label: '可用', className: 'text-accent', canRevoke: true };
}

/** Quiet ledger strip for the shared library pool. */
function StorageOverviewSection() {
  const storageQuery = useStorageOverview();

  if (storageQuery.isPending) {
    return (
      <p role="status" className="rounded-lg border border-border bg-surface/50 px-4 py-3 text-sm text-muted">
        正在核点书库…
      </p>
    );
  }
  if (storageQuery.isError) {
    return (
      <div role="alert" className={cn(alertClass, 'flex flex-wrap items-center gap-3')}>
        <span>{messageForApiError(storageQuery.error)}</span>
        <Button variant="ghost" size="sm" onClick={() => storageQuery.refetch()}>
          重试
        </Button>
      </div>
    );
  }

  const overview = storageQuery.data;
  const ratio =
    overview.totalBytes > 0 ? Math.min(1, overview.usedBytes / overview.totalBytes) : 0;

  return (
    <section
      aria-labelledby="storage-heading"
      className="rounded-lg border border-border bg-surface/70 p-5"
    >
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <div>
          <h2 id="storage-heading" className="font-serif text-lg text-ink">
            存储用量
          </h2>
          <p className="mt-0.5 text-xs text-muted">共享书库由全家共同使用。</p>
        </div>
        <p className="text-sm tabular-nums text-ink">
          {formatBytes(overview.usedBytes)}
          <span className="text-xs text-muted"> / {formatBytes(overview.totalBytes)}</span>
        </p>
      </div>

      <div aria-hidden="true" className="mt-3 h-2 overflow-hidden rounded-full bg-border/70">
        <div className="h-full rounded-full bg-accent" style={{ width: `${ratio * 100}%` }} />
      </div>

      <ul className="mt-4 grid gap-x-8 gap-y-1.5 text-xs sm:grid-cols-2 lg:grid-cols-3">
        {overview.perMember.map((member) => (
          <li key={member.userId} className="flex items-baseline gap-3">
            <span className="truncate text-ink">{member.displayName}</span>
            <span className="ml-auto tabular-nums text-muted">
              {formatBytes(member.usedBytes)}
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

interface MemberRowProps {
  member: AdminMember;
  busy: boolean;
  onToggle: (member: AdminMember, isActive: boolean) => void;
  onSaveQuota: (member: AdminMember, bytes: number) => void;
  onResetPassword: (member: AdminMember) => void;
}

/** One member row; the quota field keeps its own draft and saves on blur. */
function MemberRow({ member, busy, onToggle, onSaveQuota, onResetPassword }: MemberRowProps) {
  const [quota, setQuota] = useState(() => String(member.uploadQuotaBytes));
  const [quotaError, setQuotaError] = useState<string | null>(null);

  // A refetch after a save must replace the draft with the stored value.
  useEffect(() => {
    setQuota(String(member.uploadQuotaBytes));
  }, [member.uploadQuotaBytes]);

  function handleQuotaBlur() {
    const trimmed = quota.trim();
    const value = Number(trimmed);
    if (!/^\d+$/.test(trimmed) || !Number.isSafeInteger(value) || value <= 0) {
      setQuotaError('请输入正整数字节数');
      return;
    }
    setQuotaError(null);
    if (value !== member.uploadQuotaBytes) onSaveQuota(member, value);
  }

  return (
    <tr className="border-t border-border first:border-t-0">
      <td className={cellClass}>
        <div className="flex flex-col">
          <span className="text-ink">{member.displayName}</span>
          <span className="text-xs text-muted">@{member.username}</span>
        </div>
      </td>
      <td className={cellClass}>
        <span
          className={cn(
            'inline-flex rounded-full border px-2 py-0.5 text-xs',
            member.role === 'admin'
              ? 'border-accent/30 bg-accent/10 text-accent'
              : 'border-border text-muted',
          )}
        >
          {roleLabel(member.role)}
        </span>
      </td>
      <td className={cellClass}>
        <div className="flex items-center gap-2">
          <button
            type="button"
            role="switch"
            aria-checked={member.isActive}
            aria-label={`${member.displayName} 账号状态`}
            disabled={busy}
            onClick={() => onToggle(member, !member.isActive)}
            className={cn(
              'relative h-5 w-9 shrink-0 rounded-full transition',
              'focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-accent',
              'disabled:cursor-not-allowed disabled:opacity-60',
              member.isActive ? 'bg-accent' : 'bg-border',
            )}
          >
            <span
              aria-hidden="true"
              className={cn(
                'absolute top-0.5 size-4 rounded-full bg-paper shadow-sm transition',
                member.isActive ? 'left-[1.125rem]' : 'left-0.5',
              )}
            />
          </button>
          <span className={member.isActive ? 'text-xs text-ink' : 'text-xs text-highlight'}>
            {member.isActive ? '启用' : '停用'}
          </span>
        </div>
      </td>
      <td className={cn(cellClass, 'text-xs tabular-nums text-muted')}>
        {formatBytes(member.usedBytes)}
      </td>
      <td className={cellClass}>
        <div className="flex flex-col gap-1">
          <div className="flex items-center gap-1.5">
            <input
              type="text"
              inputMode="numeric"
              value={quota}
              aria-label={`${member.displayName} 的上传配额（字节）`}
              aria-invalid={quotaError ? true : undefined}
              disabled={busy}
              onChange={(event) => {
                setQuota(event.target.value);
                setQuotaError(null);
              }}
              onBlur={handleQuotaBlur}
              onKeyDown={(event) => {
                if (event.key === 'Enter') event.currentTarget.blur();
              }}
              className={cn(
                'w-32 rounded-md border bg-surface px-2 py-1 text-right text-xs tabular-nums text-ink',
                'focus:border-accent focus:ring-2 focus:ring-accent/20 focus:outline-none',
                'disabled:cursor-not-allowed disabled:opacity-60',
                quotaError ? 'border-highlight' : 'border-border',
              )}
            />
            <span className="text-xs text-muted">字节</span>
          </div>
          {quotaError ? (
            <p role="alert" className="text-xs text-highlight">
              {quotaError}
            </p>
          ) : (
            <p className="text-xs text-muted">{formatBytes(member.uploadQuotaBytes)}</p>
          )}
        </div>
      </td>
      <td className={cn(cellClass, 'text-right')}>
        <Button
          variant="ghost"
          size="sm"
          aria-label={`重置 ${member.displayName} 的密码`}
          disabled={busy}
          onClick={() => onResetPassword(member)}
        >
          重置密码
        </Button>
      </td>
    </tr>
  );
}

interface ResetPasswordDialogProps {
  member: AdminMember;
  onClose: () => void;
  onReset: (member: AdminMember) => void;
}

/** Replacing a password signs the member out everywhere, so it warns first. */
function ResetPasswordDialog({ member, onClose, onReset }: ResetPasswordDialogProps) {
  const updateMember = useUpdateMember();
  const [password, setPassword] = useState('');
  const [error, setError] = useState<string | null>(null);

  function submit() {
    setError(null);
    if (password.length < 10) {
      setError('新密码至少需要 10 位');
      return;
    }
    updateMember.mutate(
      { id: member.id, patch: { password } },
      {
        onSuccess: () => {
          onReset(member);
          onClose();
        },
        onError: (cause) => setError(messageForApiError(cause)),
      },
    );
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="重置密码"
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={updateMember.isPending}>
            取消
          </Button>
          <Button variant="danger" onClick={submit} loading={updateMember.isPending}>
            确认重置
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-4">
        <p className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm leading-6 text-highlight">
          重置后，{member.displayName} 在所有设备上的登录都会立即失效，需要用新密码重新登录。
        </p>
        <Input
          label="新密码"
          type="password"
          autoComplete="new-password"
          minLength={10}
          value={password}
          onChange={(event) => setPassword(event.target.value)}
          hint="至少 10 位字符"
        />
        {error ? (
          <p role="alert" className={alertClass}>
            {error}
          </p>
        ) : null}
      </div>
    </Dialog>
  );
}

/** Administration for members, invites and the shared storage pool. */
export function MembersPage() {
  const membersQuery = useMembers();
  const invitesQuery = useInvites();
  const updateMember = useUpdateMember();
  const revokeInvite = useRevokeInvite();

  const [inviteOpen, setInviteOpen] = useState(false);
  const [resetting, setResetting] = useState<AdminMember | null>(null);
  const [pageError, setPageError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);
  const dismissToast = useCallback(() => setNotice(null), []);

  function toggleActive(member: AdminMember, isActive: boolean) {
    setPageError(null);
    updateMember.mutate(
      { id: member.id, patch: { isActive } },
      {
        onSuccess: () =>
          setNotice(isActive ? `已启用 ${member.displayName}` : `已停用 ${member.displayName}`),
        onError: (cause) => setPageError(messageForApiError(cause)),
      },
    );
  }

  function saveQuota(member: AdminMember, uploadQuotaBytes: number) {
    setPageError(null);
    updateMember.mutate(
      { id: member.id, patch: { uploadQuotaBytes } },
      {
        onSuccess: () => setNotice(`已更新 ${member.displayName} 的配额`),
        onError: (cause) => setPageError(messageForApiError(cause)),
      },
    );
  }

  function revoke(code: string) {
    setPageError(null);
    revokeInvite.mutate(code, {
      onSuccess: () => setNotice('邀请码已撤销'),
      onError: (cause) => setPageError(messageForApiError(cause)),
    });
  }

  const members = membersQuery.data ?? [];
  const invites = invitesQuery.data ?? [];

  return (
    <section className="flex flex-col gap-8">
      <div>
        <h1 className="font-serif text-2xl text-ink">成员与邀请</h1>
        <p className="mt-1 text-sm text-muted">照看书房的成员、启用邀请与共享空间。</p>
      </div>

      {pageError ? (
        <p role="alert" className={alertClass}>
          {pageError}
        </p>
      ) : null}

      <StorageOverviewSection />

      <section aria-labelledby="members-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <h2 id="members-heading" className="font-serif text-lg text-ink">
            成员
          </h2>
          {membersQuery.data ? (
            <p className="text-xs tracking-widest text-muted">{members.length} 位</p>
          ) : null}
        </div>

        {membersQuery.isPending ? (
          <p role="status" className="py-10 text-center text-sm tracking-widest text-muted">
            正在读取成员名册…
          </p>
        ) : membersQuery.isError ? (
          <div role="alert" className={cn(alertClass, 'flex flex-wrap items-center gap-3')}>
            <span>{messageForApiError(membersQuery.error)}</span>
            <Button variant="ghost" size="sm" onClick={() => membersQuery.refetch()}>
              重试
            </Button>
          </div>
        ) : members.length === 0 ? (
          <EmptyState title="还没有成员" description="生成一枚邀请码，请家人加入书房。" />
        ) : (
          <div className="overflow-x-auto rounded-lg border border-border bg-surface/70">
            <table className="w-full min-w-[48rem] border-collapse text-left text-sm">
              <thead>
                <tr className="text-xs tracking-widest text-muted">
                  <th scope="col" className={cellClass}>
                    成员
                  </th>
                  <th scope="col" className={cellClass}>
                    角色
                  </th>
                  <th scope="col" className={cellClass}>
                    状态
                  </th>
                  <th scope="col" className={cellClass}>
                    已用
                  </th>
                  <th scope="col" className={cellClass}>
                    配额（字节）
                  </th>
                  <th scope="col" className={cn(cellClass, 'text-right')}>
                    操作
                  </th>
                </tr>
              </thead>
              <tbody>
                {members.map((member) => (
                  <MemberRow
                    key={member.id}
                    member={member}
                    busy={updateMember.isPending && updateMember.variables?.id === member.id}
                    onToggle={toggleActive}
                    onSaveQuota={saveQuota}
                    onResetPassword={setResetting}
                  />
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      <section aria-labelledby="invites-heading" className="flex flex-col gap-3">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h2 id="invites-heading" className="font-serif text-lg text-ink">
              邀请码
            </h2>
            <p className="mt-0.5 text-xs text-muted">每枚邀请码只能启用一位家人。</p>
          </div>
          <Button onClick={() => setInviteOpen(true)}>生成邀请码</Button>
        </div>

        {invitesQuery.isPending ? (
          <p role="status" className="py-10 text-center text-sm tracking-widest text-muted">
            正在翻看邀请…
          </p>
        ) : invitesQuery.isError ? (
          <div role="alert" className={cn(alertClass, 'flex flex-wrap items-center gap-3')}>
            <span>{messageForApiError(invitesQuery.error)}</span>
            <Button variant="ghost" size="sm" onClick={() => invitesQuery.refetch()}>
              重试
            </Button>
          </div>
        ) : invites.length === 0 ? (
          <EmptyState title="还没有邀请码" description="生成一枚，等家人来书房小坐。" />
        ) : (
          <ul className="divide-y divide-border rounded-lg border border-border bg-surface/70">
            {invites.map((invite) => {
              const state = inviteState(invite);
              const revoking = revokeInvite.isPending && revokeInvite.variables === invite.code;
              return (
                <li
                  key={invite.code}
                  className="flex flex-wrap items-center gap-x-4 gap-y-2 px-4 py-3"
                >
                  <code className="font-mono text-sm tracking-[0.18em] text-ink">
                    {invite.code}
                  </code>
                  <span className={cn('text-xs', state.className)}>{state.label}</span>
                  <span className="text-xs text-muted">
                    到期 {formatDateTime(invite.expiresAt)}
                  </span>
                  {state.canRevoke ? (
                    <Button
                      variant="ghost"
                      size="sm"
                      className="ml-auto"
                      aria-label={`撤销邀请码 ${invite.code}`}
                      loading={revoking}
                      onClick={() => revoke(invite.code)}
                    >
                      撤销
                    </Button>
                  ) : (
                    <span aria-hidden="true" className="ml-auto text-xs text-muted">
                      —
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>

      {inviteOpen ? <InviteDialog onClose={() => setInviteOpen(false)} /> : null}

      {resetting ? (
        <ResetPasswordDialog
          key={resetting.id}
          member={resetting}
          onClose={() => setResetting(null)}
          onReset={(member) => setNotice(`已重置 ${member.displayName} 的密码`)}
        />
      ) : null}

      {notice ? <Toast message={notice} onDismiss={dismissToast} /> : null}
    </section>
  );
}
