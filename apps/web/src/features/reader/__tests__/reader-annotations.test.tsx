import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it } from 'vitest';
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
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('selection', {
    text: '要复制的段落',
    locator: { kind: 'pdf', page: 2, percent: 0.2 },
    rect: { left: 30, top: 200, width: 120, height: 20 },
  });
  await userEvent.click(await screen.findByRole('button', { name: '复制' }));

  expect(await screen.findByText('已复制')).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '用黄色划线' })).not.toBeInTheDocument();
});

it('shows the conflict toast when an edit loses the revision race', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let patched: Record<string, unknown> | null = null;
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/annotations`, () =>
      HttpResponse.json({ items: [{ ...seededNote }] }),
    ),
    http.patch(`/api/books/${BOOK_ID}/annotations/:annotationId`, async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        annotation: { ...seededNote, noteText: '服务器上的批注', revision: 3 },
        conflict: true,
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
    expect(patched).toMatchObject({ noteText: '本地修改', color: 'blue', revision: 1 }),
  );
  expect(
    await screen.findByText('已在其他设备更新，旧版本已保留'),
  ).toBeInTheDocument();
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
  await userEvent.click(screen.getByRole('button', { name: '删除' }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));

  await waitFor(() => expect(deletedId).toBe('n1'));
  await waitFor(() =>
    expect(screen.queryByTestId('annotation-item')).not.toBeInTheDocument(),
  );
  expect(await screen.findByText('还没有划线和批注')).toBeInTheDocument();
});
