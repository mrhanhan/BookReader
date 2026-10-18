import { useState } from 'react';
import type { BookmarkDto, Locator } from '@bookr/shared';
import { Button, Dialog, Input } from '@bookr/ui';
import { messageForApiError } from '../../lib/errorMessages';
import type { LocalRepository } from '../../sync/repository';

export interface BookmarkDialogProps {
  open: boolean;
  bookId: string;
  userId: string;
  repo: LocalRepository;
  /** Position captured when the dialog was opened. */
  locator: Locator;
  initial?: BookmarkDto;
  onClose: () => void;
  onSaved: (bookmark: BookmarkDto) => void;
  /** Surfaces local-write failures as a reader toast. */
  onNotice?: (message: string) => void;
}

/** Names a reading position; the label is optional and may be cleared later. */
export function BookmarkDialog({
  open,
  bookId,
  userId,
  repo,
  locator,
  initial,
  onClose,
  onSaved,
  onNotice,
}: BookmarkDialogProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  function notify(message: string): void {
    setNotice(message);
    onNotice?.(message);
  }

  async function handleSave(): Promise<void> {
    if (busy) return;
    setNotice(null);
    setBusy(true);
    const trimmed = label.trim();
    try {
      const normalized = trimmed === '' ? null : trimmed;
      if (initial) {
        const saved = await repo.updateBookmark(userId, bookId, initial.id, normalized);
        if (!saved) {
          notify('这个书签已不存在');
          return;
        }
        onSaved(saved);
      } else {
        const saved = await repo.createBookmark(userId, {
          bookId,
          locator,
          label: normalized,
        });
        onSaved(saved);
      }
      onClose();
    } catch (error) {
      notify(messageForApiError(error));
    } finally {
      setBusy(false);
    }
  }

  if (!open) return null;

  return (
    <Dialog
      open={open}
      onClose={() => {
        if (!busy) onClose();
      }}
      title={initial ? '重命名书签' : '添加书签'}
      footer={
        <>
          <Button variant="ghost" onClick={onClose} disabled={busy}>
            取消
          </Button>
          <Button onClick={() => void handleSave()} loading={busy}>
            保存书签
          </Button>
        </>
      }
    >
      <div className="flex flex-col gap-3">
        {notice ? (
          <p
            role="alert"
            className="rounded-md border border-highlight/30 bg-highlight/10 px-3 py-2 text-sm text-highlight"
          >
            {notice}
          </p>
        ) : null}
        <Input
          label="书签备注"
          value={label}
          onChange={(event) => setLabel(event.target.value)}
          placeholder="给这一页起个名字（可选）"
        />
      </div>
    </Dialog>
  );
}
