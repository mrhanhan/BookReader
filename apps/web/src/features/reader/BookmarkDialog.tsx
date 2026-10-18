import { useState } from 'react';
import type { BookmarkDto, Locator } from '@bookr/shared';
import { Button, Dialog, Input } from '@bookr/ui';
import { createBookmark, updateBookmark } from '../../api/reading';
import { messageForApiError } from '../../lib/errorMessages';

export interface BookmarkDialogProps {
  open: boolean;
  bookId: string;
  /** Position captured when the dialog was opened. */
  locator: Locator;
  initial?: BookmarkDto;
  onClose: () => void;
  onSaved: (bookmark: BookmarkDto) => void;
  /** Surfaces API failures as a reader toast. */
  onNotice?: (message: string) => void;
}

/** Names a reading position; the label is optional and may be cleared later. */
export function BookmarkDialog({
  open,
  bookId,
  locator,
  initial,
  onClose,
  onSaved,
  onNotice,
}: BookmarkDialogProps) {
  const [label, setLabel] = useState(initial?.label ?? '');
  const [busy, setBusy] = useState(false);

  async function handleSave(): Promise<void> {
    if (busy) return;
    setBusy(true);
    const trimmed = label.trim();
    try {
      const saved = initial
        ? await updateBookmark(bookId, initial.id, { label: trimmed === '' ? null : trimmed })
        : await createBookmark(bookId, {
            locator,
            label: trimmed === '' ? null : trimmed,
          });
      onSaved(saved);
      onClose();
    } catch (error) {
      onNotice?.(messageForApiError(error));
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
      <Input
        label="书签备注"
        value={label}
        onChange={(event) => setLabel(event.target.value)}
        placeholder="给这一页起个名字（可选）"
      />
    </Dialog>
  );
}
