import { act, render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { describe, expect, it, vi } from 'vitest';
import { MAX_REFLOW_PACK_BYTES } from '@bookr/shared';
import type { CompleteReflowUploadResponse } from '@bookr/shared';
import { ApiError } from '../../../api/client';
import { reflowPackErrorMessage, uploadReflowPack } from '../../../api/reflow';
import { ReflowPackSection } from '../ReflowPackSection';
import { book } from '../../../../test/setup';

const PACK_SUMMARY = { schemaVersion: 1, pageCount: 300, blockCount: 2400, fallbackPages: [] };
const SOURCE_SHA = 'c'.repeat(64);

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

function packFile(): File {
  return new File(
    [JSON.stringify({ schemaVersion: 1, source: { sha256: SOURCE_SHA } })],
    'book.bookr.json',
    { type: 'application/json' },
  );
}

const sectionBook = () => book({ id: 'book-csapp', title: '深入理解计算机系统' });

it('uploads a pack and reports page count', async () => {
  const onChanged = vi.fn();
  const upload = vi.fn(async (_file: File, onProgress: (n: number) => void) => {
    onProgress(50);
    return completeResponse();
  });

  render(<ReflowPackSection book={sectionBook()} onChanged={onChanged} upload={upload} />);

  expect(screen.getByText('尚未上传重排包')).toBeInTheDocument();

  await userEvent.upload(screen.getByLabelText('选择重排包'), packFile());

  await waitFor(() => expect(onChanged).toHaveBeenCalled());
  expect(screen.getByText(/300 页/)).toBeInTheDocument();
  expect(screen.getByText(/schema v1/)).toBeInTheDocument();
  expect(upload).toHaveBeenCalledWith(expect.any(File), expect.any(Function));
});

it('shows upload progress and aborts a cancelled upload', async () => {
  let resolveUpload: ((value: CompleteReflowUploadResponse) => void) | undefined;
  const upload = vi.fn(
    (_file: File, onProgress: (n: number) => void) =>
      new Promise<CompleteReflowUploadResponse>((resolve) => {
        onProgress(50);
        resolveUpload = resolve;
      }),
  );
  const onChanged = vi.fn();

  render(<ReflowPackSection book={sectionBook()} onChanged={onChanged} upload={upload} />);
  await userEvent.upload(screen.getByLabelText('选择重排包'), packFile());

  expect(await screen.findByText('上传中 50%')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '取消上传' }));
  expect(screen.queryByText('上传中 50%')).toBeNull();

  // A result that arrives after cancellation must be ignored.
  await act(async () => {
    resolveUpload?.(completeResponse());
  });
  expect(onChanged).not.toHaveBeenCalled();
  expect(screen.queryByText(/300 页/)).toBeNull();
});

it('rejects non-JSON and oversized files without calling upload', async () => {
  const upload = vi.fn();
  render(<ReflowPackSection book={sectionBook()} upload={upload} />);

  const input = screen.getByLabelText('选择重排包');
  await userEvent.upload(input, new File(['{}'], 'notes.txt', { type: 'text/plain' }), {
    applyAccept: false,
  });
  expect(await screen.findByText('仅支持 .bookr.json 重排包')).toBeInTheDocument();

  const oversized = new File(['{}'], 'book.bookr.json', { type: 'application/json' });
  Object.defineProperty(oversized, 'size', { value: MAX_REFLOW_PACK_BYTES + 1 });
  await userEvent.upload(input, oversized);
  expect(await screen.findByText('重排包不能超过 32 MB')).toBeInTheDocument();

  expect(upload).not.toHaveBeenCalled();
});

it('shows the local pack error without creating a session', async () => {
  const create = vi.fn();
  const post = vi.fn();
  const complete = vi.fn();
  const upload = vi.fn((file: File, onProgress: (n: number) => void) =>
    uploadReflowPack('book-csapp', file, {
      onProgress,
      deps: { create, post, complete },
    }),
  );

  render(<ReflowPackSection book={sectionBook()} upload={upload} />);
  const input = screen.getByLabelText('选择重排包');

  await userEvent.upload(
    input,
    new File(['not json'], 'broken.bookr.json', { type: 'application/json' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('重排包不是有效的 JSON 文件'),
  );

  await userEvent.upload(
    input,
    new File(['{"schemaVersion":1}'], 'missing.bookr.json', { type: 'application/json' }),
  );
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('重排包缺少有效的 source.sha256'),
  );

  await userEvent.upload(
    input,
    new File(['{"source":{"sha256":"abc"}}'], 'invalid.bookr.json', {
      type: 'application/json',
    }),
  );
  await waitFor(() =>
    expect(screen.getByRole('alert')).toHaveTextContent('重排包缺少有效的 source.sha256'),
  );

  expect(create).not.toHaveBeenCalled();
  expect(post).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
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

it('leaves the pack alone when removal is cancelled', async () => {
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
      remove={remove}
    />,
  );

  await userEvent.click(screen.getByRole('button', { name: '移除重排包' }));
  await userEvent.click(screen.getByRole('button', { name: '取消' }));

  expect(remove).not.toHaveBeenCalled();
  expect(screen.getByRole('button', { name: '移除重排包' })).toBeInTheDocument();
  expect(screen.getByText(/300 页/)).toBeInTheDocument();
});

it('shows the 422 message when the pack does not match the book', async () => {
  const upload = vi.fn(async () => {
    throw new ApiError(422, 'REFLOW_INVALID', 'The reflow pack is not valid', {
      reason: 'pack/invalid',
    });
  });

  render(<ReflowPackSection book={sectionBook()} upload={upload} />);

  await userEvent.upload(screen.getByLabelText('选择重排包'), packFile());

  expect(await screen.findByRole('alert')).toHaveTextContent(
    '重排包格式无效，请重新生成',
  );
});

it('shows a network message when the API cannot be reached', async () => {
  const create = vi.fn(async () => {
    throw new TypeError('Failed to fetch');
  });
  const upload = vi.fn((file: File, onProgress: (n: number) => void) =>
    uploadReflowPack('book-csapp', file, { onProgress, deps: { create } }),
  );

  render(<ReflowPackSection book={sectionBook()} upload={upload} />);
  await userEvent.upload(screen.getByLabelText('选择重排包'), packFile());

  expect(await screen.findByRole('alert')).toHaveTextContent(
    '网络连接失败，请检查网络后重试',
  );
  expect(screen.queryByText(/Failed to fetch/)).toBeNull();
});

it('renders nothing for non-PDF books', () => {
  const { container } = render(
    <ReflowPackSection book={book({ id: 'book-epub', title: '三体', format: 'epub' })} />,
  );

  expect(container).toBeEmptyDOMElement();
});

describe('reflowPackErrorMessage', () => {
  it('maps every REFLOW_INVALID reason and falls back for unknown ones', () => {
    expect(
      reflowPackErrorMessage(
        new ApiError(422, 'REFLOW_INVALID', 'x', { reason: 'pack/invalid' }),
      ),
    ).toBe('重排包格式无效，请重新生成');
    expect(
      reflowPackErrorMessage(
        new ApiError(422, 'REFLOW_INVALID', 'x', { reason: 'pack/source-mismatch' }),
      ),
    ).toBe('重排包与当前图书的源文件不匹配');
    expect(
      reflowPackErrorMessage(new ApiError(422, 'REFLOW_INVALID', 'x', { reason: 'pack/size' })),
    ).toBe('重排包大小不符，请重新生成');
    expect(
      reflowPackErrorMessage(
        new ApiError(422, 'REFLOW_INVALID', 'x', { reason: 'pack/missing' }),
      ),
    ).toBe('上传未完成，请重试');
    expect(
      reflowPackErrorMessage(
        new ApiError(422, 'REFLOW_INVALID', 'x', { reason: 'pack/unknown' }),
      ),
    ).toBe('重排包与这本书不匹配');
  });

  it('keeps the generic code message for other failures', () => {
    expect(reflowPackErrorMessage(new ApiError(500, 'INTERNAL', 'boom'))).toBe(
      '服务器出了点问题，请稍后重试',
    );
  });
});

describe('uploadReflowPack', () => {
  const pipelineDeps = () => ({
    create: vi.fn(async () => {
      throw new Error('create must not run');
    }),
    post: vi.fn(async () => undefined),
    complete: vi.fn(async () => {
      throw new Error('complete must not run');
    }),
  });

  it('declares the embedded source hash and runs the pipeline in order', async () => {
    const calls: string[] = [];
    const file = packFile();
    const create = vi.fn(async (bookId: string, input: { size: number; sha256: string }) => {
      calls.push('create');
      expect(bookId).toBe('book-csapp');
      expect(input).toEqual({ size: file.size, sha256: SOURCE_SHA });
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
    expect(complete).toHaveBeenCalledWith('book-csapp', 'upload-1', undefined);
    expect(result.book.reflowPageCount).toBe(300);
  });

  it('rejects malformed packs and invalid source hashes before creating a session', async () => {
    const deps = pipelineDeps();

    await expect(
      uploadReflowPack(
        'book-csapp',
        new File(['not json'], 'broken.bookr.json', { type: 'application/json' }),
        { deps },
      ),
    ).rejects.toThrow('重排包不是有效的 JSON 文件');

    await expect(
      uploadReflowPack(
        'book-csapp',
        new File(['{"schemaVersion":1}'], 'missing.bookr.json', {
          type: 'application/json',
        }),
        { deps },
      ),
    ).rejects.toThrow('重排包缺少有效的 source.sha256');

    expect(deps.create).not.toHaveBeenCalled();
    expect(deps.post).not.toHaveBeenCalled();
    expect(deps.complete).not.toHaveBeenCalled();
  });

  it('rejects non-JSON names and oversized files before reading them', async () => {
    const deps = pipelineDeps();
    const oversized = new File(['{}'], 'book.bookr.json', { type: 'application/json' });
    Object.defineProperty(oversized, 'size', { value: MAX_REFLOW_PACK_BYTES + 1 });

    await expect(
      uploadReflowPack('book-csapp', new File(['{}'], 'book.pdf'), { deps }),
    ).rejects.toThrow('仅支持 .bookr.json 重排包');
    await expect(uploadReflowPack('book-csapp', oversized, { deps })).rejects.toThrow(
      '重排包不能超过 32 MB',
    );

    expect(deps.create).not.toHaveBeenCalled();
  });

  it('stops the pipeline when the upload is aborted during completion', async () => {
    const controller = new AbortController();
    const onProgress = vi.fn();
    const complete = vi.fn(async () => {
      // The request is already in flight when the user closes the dialog; a
      // fake that ignores the signal must not let the pipeline report success.
      controller.abort();
      return completeResponse();
    });

    await expect(
      uploadReflowPack('book-csapp', packFile(), {
        signal: controller.signal,
        onProgress,
        deps: {
          hash: async () => SOURCE_SHA,
          create: async () => ({
            uploadId: 'upload-1',
            upload: { url: 'https://files.test/reflow', fields: {} },
            expiresAt: '2026-01-01T00:00:00.000Z',
          }),
          post: async () => undefined,
          complete,
        },
      }),
    ).rejects.toMatchObject({ name: 'AbortError' });

    expect(complete).toHaveBeenCalledTimes(1);
    expect(onProgress).not.toHaveBeenCalledWith(100);
  });

  it('surfaces a completion ApiError unchanged', async () => {
    const failure = new ApiError(422, 'REFLOW_INVALID', 'The reflow pack is not valid');
    const options = {
      deps: {
        hash: async () => SOURCE_SHA,
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
