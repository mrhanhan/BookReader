import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';
import { createFakeEngine } from './fake-engine';
import type { FakeReaderEngine } from './fake-engine';

const BOOK_ID = 'book-csapp';

const pdfFile = () =>
  HttpResponse.json({
    url: 'https://files.test/book.pdf',
    format: 'pdf',
    expiresIn: 3600,
  });

const seededNote = {
  id: 'n1',
  bookId: BOOK_ID,
  type: 'note' as const,
  color: 'blue' as const,
  locator: { kind: 'pdf' as const, page: 4, percent: 0.3 },
  selectedText: '原文',
  noteText: '我的批注',
  tags: ['历史'],
  revision: 1,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

const seededHighlight = {
  id: 'h1',
  bookId: BOOK_ID,
  type: 'highlight' as const,
  color: 'yellow' as const,
  locator: { kind: 'pdf' as const, page: 3, percent: 0.25 },
  selectedText: '一段原文',
  noteText: null,
  tags: ['重点'],
  revision: 2,
  createdAt: new Date().toISOString(),
  updatedAt: new Date().toISOString(),
};

function renderReader(engine: FakeReaderEngine = createFakeEngine()) {
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  const view = renderWithProviders(<RouterProvider router={router} />);
  return { engine, ...view };
}

it('creates a highlight from a text selection and renders it in the engine', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let posted: Record<string, unknown> | null = null;
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items: [] })),
    http.post(`/api/books/${BOOK_ID}/annotations`, async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          annotation: {
            id: 'a1',
            bookId: BOOK_ID,
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            noteText: null,
            tags: [],
            ...posted,
          },
        },
        { status: 201 },
      );
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '被选中的原文',
    locator: {
      kind: 'pdf',
      page: 2,
      percent: 0.2,
      rect: { x: 0.1, y: 0.2, w: 0.4, h: 0.03 },
    },
    rect: { left: 10, top: 20, width: 100, height: 18 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '用黄色划线' }));
  await waitFor(() =>
    expect(posted).toMatchObject({
      type: 'highlight',
      color: 'yellow',
      selectedText: '被选中的原文',
    }),
  );
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'a1', color: 'yellow', hasNote: false }),
    ]),
  );
});

it('creates a note with text and jumps back from the notes panel', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () =>
      HttpResponse.json({ items: [{ ...seededNote }] }),
    ),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));
  await userEvent.click(await screen.findByText('我的批注'));
  expect(engine.goTo).toHaveBeenCalledWith({ kind: 'pdf', page: 4, percent: 0.3 }, { flash: true });
});

it('creates a note from the selection menu with the chosen color and normalized tags', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let posted: Record<string, unknown> | null = null;
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items: [] })),
    http.post(`/api/books/${BOOK_ID}/annotations`, async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json(
        {
          annotation: {
            id: 'note-1',
            bookId: BOOK_ID,
            revision: 1,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString(),
            noteText: null,
            tags: [],
            ...posted,
          },
        },
        { status: 201 },
      );
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '需要注释的原文',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '写批注' }));
  await userEvent.click(screen.getByRole('button', { name: '颜色：蓝色' }));
  await userEvent.type(screen.getByLabelText('批注内容'), '我的想法');
  await userEvent.type(screen.getByLabelText('标签（用逗号分隔）'), '历史， 文学,历史');
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(() =>
    expect(posted).toMatchObject({
      type: 'note',
      color: 'blue',
      noteText: '我的想法',
      tags: ['历史', '文学'],
      selectedText: '需要注释的原文',
    }),
  );
});

it('copies the selection and shows a confirmation toast', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const user = userEvent.setup();
  const writeText = vi.spyOn(navigator.clipboard, 'writeText');
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '要复制的段落',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await user.click(await screen.findByRole('button', { name: '复制' }));

  expect(writeText).toHaveBeenCalledWith('要复制的段落');
  expect(await screen.findByText('已复制')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '用黄色划线' })).not.toBeInTheDocument();
  writeText.mockRestore();
});

it('recolors a pure highlight without sending a blank note', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let patched: Record<string, unknown> | null = null;
  const items = [{ ...seededHighlight }];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items })),
    http.patch(`/api/books/${BOOK_ID}/annotations/:annotationId`, async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>;
      const updated = {
        ...seededHighlight,
        color: (patched.color as typeof seededHighlight.color) ?? 'yellow',
        revision: seededHighlight.revision + 1,
      };
      items[0] = updated;
      return HttpResponse.json({ annotation: updated, conflict: false });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'h1', color: 'yellow', hasNote: false }),
    ]),
  );

  engine.emit('highlightClick', { id: 'h1' });
  expect(await screen.findByLabelText('批注内容')).toHaveValue('');
  await userEvent.click(screen.getByRole('button', { name: '颜色：绿色' }));
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(() =>
    expect(patched).toMatchObject({
      color: 'green',
      revision: 2,
      tags: ['重点'],
      noteText: null,
    }),
  );
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'h1', color: 'green', hasNote: false }),
    ]),
  );
});

it('clears a highlight note when the text is emptied', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let patched: Record<string, unknown> | null = null;
  const items: Array<Record<string, unknown>> = [{ ...seededHighlight, noteText: '旧批注' }];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items })),
    http.patch(`/api/books/${BOOK_ID}/annotations/:annotationId`, async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>;
      const updated = {
        ...seededHighlight,
        noteText: patched.noteText as string | null,
        revision: seededHighlight.revision + 1,
      };
      items[0] = updated;
      return HttpResponse.json({ annotation: updated, conflict: false });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'h1', hasNote: true }),
    ]),
  );

  engine.emit('highlightClick', { id: 'h1' });
  const textarea = await screen.findByLabelText('批注内容');
  expect(textarea).toHaveValue('旧批注');
  await userEvent.clear(textarea);
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(() => expect(patched).toMatchObject({ noteText: null, revision: 2 }));
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'h1', hasNote: false }),
    ]),
  );
});

it('adopts the server copy when an edit loses the revision race', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const conflictText = '已在其他设备更新，旧版本已保留';
  const patches: Array<Record<string, unknown>> = [];
  const items = [{ ...seededNote }];
  let calls = 0;
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items })),
    http.patch(`/api/books/${BOOK_ID}/annotations/:annotationId`, async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      patches.push(body);
      const current = items[0]!;
      calls += 1;

      // The first save races with an edit made elsewhere: the server keeps the
      // newer text at revision 3 and reports the conflict.
      if (calls === 1) {
        const updated = { ...current, noteText: '服务器上的批注', revision: 3 };
        items[0] = updated;
        return HttpResponse.json({ annotation: updated, conflict: true });
      }

      const updated = { ...current, revision: current.revision + 1 };
      items[0] = updated;
      return HttpResponse.json({
        annotation: updated,
        conflict: body.revision !== current.revision,
      });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'n1', hasNote: true }),
    ]),
  );

  engine.emit('highlightClick', { id: 'n1' });
  const textarea = await screen.findByLabelText('批注内容');
  expect(textarea).toHaveValue('我的批注');
  await userEvent.clear(textarea);
  await userEvent.type(textarea, '本地修改');
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));

  await waitFor(() =>
    expect(patches[0]).toMatchObject({ noteText: '本地修改', color: 'blue', revision: 1 }),
  );
  // Both the inline notice (visible above a modal) and the page toast report it.
  expect(await screen.findByRole('alert')).toHaveTextContent(conflictText);
  expect(screen.getAllByText(conflictText)).toHaveLength(2);

  // The dialog stays open with the server copy, so the next save is based on
  // the latest revision rather than replaying the stale one.
  expect(screen.getByLabelText('批注内容')).toHaveValue('服务器上的批注');
  await userEvent.click(screen.getByRole('button', { name: '保存批注' }));
  await waitFor(() =>
    expect(patches[1]).toMatchObject({ noteText: '服务器上的批注', revision: 3 }),
  );

  await userEvent.click(screen.getByRole('button', { name: '笔记' }));
  expect(await screen.findByText('服务器上的批注')).toBeInTheDocument();
  await waitFor(() =>
    expect(engine.setHighlights).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'n1', hasNote: true }),
    ]),
  );
});

it('deletes an annotation after confirmation', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let deletedId: string | null = null;
  const items = [{ ...seededNote }];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items })),
    http.delete(`/api/books/${BOOK_ID}/annotations/:annotationId`, ({ params }) => {
      deletedId = String(params.annotationId);
      items.splice(0, items.length);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));
  await screen.findByText('我的批注');
  await userEvent.click(screen.getByRole('button', { name: /^删除：/ }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));

  await waitFor(() => expect(deletedId).toBe('n1'));
  await waitFor(() =>
    expect(screen.queryByTestId('annotation-item')).not.toBeInTheDocument(),
  );
  expect(await screen.findByText('还没有划线和批注')).toBeInTheDocument();
});

it('dismisses the selection menu on outside input, Escape or a cleared selection', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  const selection = {
    text: '待处理的选中文本',
    locator: { kind: 'pdf' as const, page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  };
  const yellow = () => screen.queryByRole('button', { name: '用黄色划线' });

  engine.emit('selection', selection);
  expect(await screen.findByRole('button', { name: '用黄色划线' })).toBeInTheDocument();
  fireEvent.pointerDown(document.body);
  await waitFor(() => expect(yellow()).not.toBeInTheDocument());

  engine.emit('selection', selection);
  expect(await screen.findByRole('button', { name: '用黄色划线' })).toBeInTheDocument();
  await userEvent.keyboard('{Escape}');
  await waitFor(() => expect(yellow()).not.toBeInTheDocument());

  engine.emit('selection', selection);
  expect(await screen.findByRole('button', { name: '用黄色划线' })).toBeInTheDocument();
  engine.emit('selection', null);
  await waitFor(() => expect(yellow()).not.toBeInTheDocument());
});

it('keeps the open dialog and panel stable while reader shortcuts fire', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const items = [{ ...seededNote }];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items })),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));
  await screen.findByText('我的批注');
  engine.emit('highlightClick', { id: 'n1' });
  expect(await screen.findByLabelText('批注内容')).toBeInTheDocument();

  // Selections made under a modal are ignored.
  engine.emit('selection', {
    text: '对话框下的选中文本',
    locator: { kind: 'pdf', page: 4, percent: 0.3 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  expect(screen.queryByRole('button', { name: '用黄色划线' })).not.toBeInTheDocument();

  // `b` must not queue a bookmark dialog over the in-progress edit.
  await userEvent.keyboard('b');
  expect(screen.queryByLabelText('书签备注')).not.toBeInTheDocument();
  expect(screen.getByLabelText('批注内容')).toBeInTheDocument();

  // Escape belongs to the dialog, so the notes panel behind it stays open.
  await userEvent.keyboard('{Escape}');
  expect(screen.getByRole('heading', { name: '笔记' })).toBeInTheDocument();
  expect(screen.getByLabelText('批注内容')).toBeInTheDocument();
});

it('shows an API error toast when a highlight cannot be saved', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () => HttpResponse.json({ items: [] })),
    http.post(`/api/books/${BOOK_ID}/annotations`, () =>
      HttpResponse.json(
        { error: { code: 'INTERNAL', message: 'boom' } },
        { status: 500 },
      ),
    ),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '无法保存的选中文本',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '用绿色划线' }));

  expect(await screen.findByText('服务器出了点问题，请稍后重试')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '用绿色划线' })).not.toBeInTheDocument();
});
