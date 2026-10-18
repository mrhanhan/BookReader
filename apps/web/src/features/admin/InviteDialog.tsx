import { useEffect, useRef, useState } from 'react';
import { Button, Dialog } from '@bookr/ui';
import { useCreateInvite } from '../../api/admin';
import type { CreatedInvite } from '../../api/admin';
import { messageForApiError } from '../../lib/errorMessages';
import { formatDateTime } from '../../lib/format';

/** Invites live three days by default, matching the server's own default. */
const DEFAULT_INVITE_HOURS = 72;

export interface InviteDialogProps {
  onClose: () => void;
}

/**
 * Mints a fresh invite as soon as it opens and reveals the code in a
 * monospace block. The code is only ever shown here, so copying is offered
 * explicitly rather than relying on the administrator to select the text.
 */
export function InviteDialog({ onClose }: InviteDialogProps) {
  const createInvite = useCreateInvite();
  const [created, setCreated] = useState<CreatedInvite | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copyError, setCopyError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);
  // StrictMode replays effects; the ref keeps the POST from running twice and
  // minting two codes.
  const started = useRef(false);
  const { mutate } = createInvite;

  useEffect(() => {
    if (started.current) return;
    started.current = true;
    mutate(
      { expiresInHours: DEFAULT_INVITE_HOURS },
      {
        onSuccess: (invite) => setCreated(invite),
        onError: (cause) => setError(messageForApiError(cause)),
      },
    );
  }, [mutate]);

  async function copyCode() {
    if (!created) return;
    setCopyError(null);
    try {
      await navigator.clipboard.writeText(created.code);
      setCopied(true);
    } catch {
      // Copying is a convenience; the code block stays visible for manual
      // selection, so this must never replace it.
      setCopyError('无法自动复制，请手动选中邀请码。');
    }
  }

  return (
    <Dialog
      open
      onClose={onClose}
      title="新邀请码"
      footer={
        <Button variant="ghost" onClick={onClose}>
          关闭
        </Button>
      }
    >
      {created ? (
        <div className="flex flex-col gap-4">
          <p className="text-sm leading-6 text-ink">
            把邀请码转给家人。{DEFAULT_INVITE_HOURS} 小时内有效，启用后仅可使用一次。
          </p>
          <div className="flex flex-wrap items-center gap-3 rounded-md border border-border bg-paper px-4 py-3">
            <code className="flex-1 font-mono text-lg tracking-[0.2em] text-ink">
              {created.code}
            </code>
            <Button variant="ghost" size="sm" onClick={copyCode}>
              {copied ? '已复制' : '复制'}
            </Button>
          </div>
          {copyError ? (
            <p role="status" className="text-xs text-highlight">
              {copyError}
            </p>
          ) : null}
          <p className="text-xs text-muted">到期时间：{formatDateTime(created.expiresAt)}</p>
        </div>
      ) : error ? (
        <p
          role="alert"
          className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
        >
          {error}
        </p>
      ) : (
        <p role="status" className="text-sm tracking-widest text-muted">
          正在生成邀请码…
        </p>
      )}
    </Dialog>
  );
}
