import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { MemoryRouter } from 'react-router';
import { expect, it, vi } from 'vitest';
import type { BookDto } from '@bookr/shared';
import { DuplicateBookError, QuotaExceededError } from '../../../lib/upload';
import type { UploadOptions } from '../../../lib/upload';
import { UploadDialog } from '../UploadDialog';
import type { UploadDialogProps } from '../UploadDialog';

const file = new File(['%PDF-1.7'], 'a.pdf', { type: 'application/pdf' });

interface RenderDialogOptions {
  rejectWith?: Error;
  resolveWith?: BookDto;
  upload?: UploadDialogProps['upload'];
}

/** Renders the dialog with an injected upload so error states are deterministic. */
function renderDialog({ rejectWith, resolveWith, upload: injected }: RenderDialogOptions = {}) {
  const upload =
    injected ??
    vi.fn(async () => {
      if (rejectWith) throw rejectWith;
      return resolveWith ?? ({ id: 'b1', title: 'a' } as BookDto);
    });
  const onClose = vi.fn();
  const onUploaded = vi.fn();

  render(
    <MemoryRouter>
      <UploadDialog upload={upload} onClose={onClose} onUploaded={onUploaded} />
    </MemoryRouter>,
  );

  return { upload, onClose, onUploaded };
}

it('shows the duplicate message with a link to the existing book', async () => {
  renderDialog({ rejectWith: new DuplicateBookError('b1') });
  await userEvent.upload(screen.getByLabelText('选择文件'), file);
  expect(await screen.findByText('这本书已经在书架里了')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '查看已有图书' })).toHaveAttribute('href', '/books/b1');
});

it('shows a quota message when the shelf is full', async () => {
  renderDialog({ rejectWith: new QuotaExceededError() });
  await userEvent.upload(screen.getByLabelText('选择文件'), file);
  expect(await screen.findByText('共享书库空间不足，请联系管理员')).toBeInTheDocument();
});

it('reports a successful upload and closes once the queue drains', async () => {
  const { onUploaded, onClose } = renderDialog();
  await userEvent.upload(screen.getByLabelText('选择文件'), file);

  await waitFor(() =>
    expect(onUploaded).toHaveBeenCalledWith(expect.objectContaining({ id: 'b1' })),
  );
  await waitFor(() => expect(onClose).toHaveBeenCalledTimes(1));
  expect(screen.getByText('已完成')).toBeInTheDocument();
});

it('shows the size limit from the injected upload', async () => {
  const { InvalidFileError } = await import('../../../lib/upload');
  renderDialog({ rejectWith: new InvalidFileError('单本上限 500 MB') });
  await userEvent.upload(screen.getByLabelText('选择文件'), file);
  expect(await screen.findByText('单本上限 500 MB')).toBeInTheDocument();
});

it('cancels an in-flight upload through its AbortSignal', async () => {
  const upload = vi.fn(
    (_file: File, options: UploadOptions) =>
      new Promise<BookDto>((_resolve, reject) => {
        options.signal?.addEventListener('abort', () =>
          reject(new DOMException('Aborted', 'AbortError')),
        );
      }),
  );
  renderDialog({ upload });

  await userEvent.upload(screen.getByLabelText('选择文件'), file);
  await userEvent.click(
    await screen.findByRole('button', { name: '取消上传《a.pdf》' }),
  );

  expect(await screen.findByText('已取消')).toBeInTheDocument();
});

it('runs at most three uploads at once and drains the queue as slots free up', async () => {
  const resolvers: Array<() => void> = [];
  const upload = vi.fn(
    () =>
      new Promise<BookDto>((resolve) => {
        resolvers.push(() => resolve({ id: `book-${resolvers.length}`, title: 'a' } as BookDto));
      }),
  );
  renderDialog({ upload });

  const files = Array.from(
    { length: 5 },
    (_, index) => new File(['%PDF-1.7'], `book-${index}.pdf`, { type: 'application/pdf' }),
  );
  await userEvent.upload(screen.getByLabelText('选择文件'), files);

  expect(upload).toHaveBeenCalledTimes(3);

  await act(async () => resolvers[0]!());
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(4));

  await act(async () => {
    for (const resolve of resolvers.slice(1)) resolve();
  });
  await waitFor(() => expect(upload).toHaveBeenCalledTimes(5));
});
