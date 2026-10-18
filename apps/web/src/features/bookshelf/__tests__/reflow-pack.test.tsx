import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MAX_REFLOW_PACK_BYTES } from '@bookr/shared';
import type { CompleteReflowUploadResponse } from '@bookr/shared';
import { ApiError } from '../../../api/client';
import { uploadReflowPack } from '../../../api/reflow';
import { ReflowPackSection } from '../ReflowPackSection';
import { book } from '../../../../test/setup';

const PACK_SUMMARY = { schemaVersion: 1, pageCount: 300, blockCount: 2400, fallbackPages: [] };

function completeResponse(overrides: Partial<CompleteReflowUploadResponse['book']> = {}) {
  return {
    book: book({
      id: 'book-csapp',
      title: '深入理解计算机系统',
      reflowAvailable: true,
      reflowSchemaVersion: 1,
      reflowPageCount: 300,
      ...overrides,
    }),
    pack: PACK_SUMMARY,
  };
}

it('uploads a pack and reports page count', async () => {
  const onChanged = vi.fn();
  const upload = vi.fn(async (_file: File, onProgress: (n: number) => void) => {
    onProgress(50);
    return completeResponse();
  });

  render(
    <ReflowPackSection
      book={book({ id: 'book-csapp', title: '深入理解计算机系统' })}
      onChanged={onChanged}
      upload={upload}
    />,
  );

  expect(screen.getByText('尚未上传重排包')).toBeInTheDocument();

  await userEvent.upload(
    screen.getByLabelText('选择重排包'),
    new File(['{}'], 'book.bookr.json', { type: 'application/json' }),
  );

  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(screen.getByText(/300 页/)).toBeInTheDocument();
  expect(screen.getByText(/schema v1/)).toBeInTheDocument();
});

it('rejects non-JSON and oversized files without calling upload', async () => {
  const upload = vi.fn();
  render(<ReflowPackSection book={book({ id: 'book-csapp', title: '书' })} upload={upload} />);

  const input = screen.getByLabelText('选择重排包');
  await userEvent.upload(
    input,
    new File(['{}'], 'notes.txt', { type: 'text/plain' }),
    { applyAccept: false },
  );
  expect(await screen.findByText('仅支持 .bookr.json 重排包')).toBeInTheDocument();

  const oversized = new File(['{}'], 'book.bookr.json', { type: 'application/json' });
  Object.defineProperty(oversized, 'size', { value: MAX_REFLOW_PACK_BYTES + 1 });
  await userEvent.upload(input, oversized);
  expect(await screen.findByText('重排包不能超过 32 MB')).toBeInTheDocument();

  expect(upload).not.toHaveBeenCalled();
});

it('removes an existing pack after confirmation', async () => {
  const onChanged = vi.fn();
  const remove = vi.fn(async () => undefined);

  render(
    <ReflowPackSection
      book={book({
        id: 'book-csapp',
        title: '书',
        reflowAvailable: true,
        reflowSchemaVersion: 1,
        reflowPageCount: 300,
      })}
      onChanged={onChanged}
      remove={remove}
    />,
  );

  expect(screen.getByText(/300 页/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '移除重排包' }));
  expect(screen.getByRole('button', { name: '确认移除' })).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '取消' })).toBeInTheDocument();
  expect(remove).not.toHaveBeenCalled();

  await userEvent.click(screen.getByRole('button', { name: '确认移除' }));

  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(screen.getByText('尚未上传重排包')).toBeInTheDocument();
  expect(onChanged).toHaveBeenCalledWith(
    expect.objectContaining({
      reflowAvailable: false,
      reflowSchemaVersion: null,
      reflowPageCount: null,
    }),
  );
});

it('shows the 422 message when the pack does not match the book', async () => {
  const upload = vi.fn(async () => {
    throw new ApiError(422, 'REFLOW_INVALID', 'The reflow pack is not valid for this book');
  });

  render(<ReflowPackSection book={book({ id: 'book-csapp', title: '书' })} upload={upload} />);

  await userEvent.upload(
    screen.getByLabelText('选择重排包'),
    new File(['{}'], 'book.bookr.json', { type: 'application/json' }),
  );

  expect(await screen.findByRole('alert')).toHaveTextContent('重排包与这本书不匹配');
});

describe('uploadReflowPack', () => {
  const sourceSha = 'c'.repeat(64);

  function packFile(): File {
    return new File(
      [JSON.stringify({ schemaVersion: 1, source: { sha256: sourceSha } })],
      'book.bookr.json',
      { type: 'application/json' },
    );
  }

  it('declares the embedded source hash and runs the pipeline in order', async () => {
    const calls: string[] = [];
    const file = packFile();
    const create = vi.fn(async (bookId: string, input: { size: number; sha256: string }) => {
      calls.push('create');
      expect(bookId).toBe('book-csapp');
      expect(input).toEqual({ size: file.size, sha256: sourceSha });
      return {
        uploadId: 'upload-1',
        upload: { url: 'https://files.test/reflow', fields: { key: 'reflow-key' } },
        expiresAt: '2026-01-01T00:00:00.000Z',
      };
    });
    const post = vi.fn(async () => {
      calls.push('post');
    });
    const complete = vi.fn(async () => {
      calls.push('complete');
      return completeResponse();
    });

    const result = await uploadReflowPack('book-csapp', file, {
      deps: { create, post, complete },
    });

    expect(calls).toEqual(['create', 'post', 'complete']);
    expect(complete).toHaveBeenCalledWith('book-csapp', 'upload-1');
    expect(result.book.reflowPageCount).toBe(300);
  });

  it('surfaces a completion ApiError unchanged', async () => {
    const failure = new ApiError(422, 'REFLOW_INVALID', 'The reflow pack is not valid');
    const options = {
      deps: {
        hash: async () => sourceSha,
        create: async () => ({
          uploadId: 'upload-1',
          upload: { url: 'https://files.test/reflow', fields: {} },
          expiresAt: '2026-01-01T00:00:00.000Z',
        }),
        post: async () => undefined,
        complete: async () => {
          throw failure;
        },
      },
    };

    await expect(uploadReflowPack('book-csapp', packFile(), options)).rejects.toBe(failure);
  });
});
