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
const LOCATOR = { kind: 'pdf' as const, page: 2, percent: 0.42 };

const pdfFile = () =>
  HttpResponse.json({
    url: 'https://files.test/book.pdf',
    format: 'pdf',
    expiresIn: 3600,
  });

const seededBookmark = {
  id: 'bm1',
  bookId: BOOK_ID,
  locator: { kind: 'pdf' as const, page: 3, percent: 0.3 },
  label: '开篇',
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

it('creates a bookmark at the current position and jumps to it', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let posted: Record<string, unknown> | null = null;
  // A mutable list mirrors the MSW fixture table so refetches stay consistent.
  const items: Array<Record<string, unknown>> = [];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/bookmarks`, () => HttpResponse.json({ items })),
    http.post(`/api/books/${BOOK_ID}/bookmarks`, async ({ request }) => {
      posted = (await request.json()) as Record<string, unknown>;
      const bookmark = {
        id: 'bookmark-1',
        bookId: BOOK_ID,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        ...posted,
      };
      items.unshift(bookmark);
      return HttpResponse.json({ bookmark }, { status: 201 });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await userEvent.click(await screen.findByRole('button', { name: '添加书签' }));
  await userEvent.type(screen.getByLabelText('书签备注'), '第二页');
  await userEvent.click(screen.getByRole('button', { name: '保存书签' }));

  await waitFor(() => expect(posted).toMatchObject({ locator: LOCATOR, label: '第二页' }));
  const label = await screen.findByRole('button', { name: '第二页' });
  expect(screen.getByTestId('bookmark-item')).toBeInTheDocument();

  await userEvent.click(label);
  expect(engine.goTo).toHaveBeenCalledWith(LOCATOR, { flash: true });
});

it('renames a bookmark from the panel', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let patched: Record<string, unknown> | null = null;
  const items = [{ ...seededBookmark }];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/bookmarks`, () => HttpResponse.json({ items })),
    http.patch(`/api/books/${BOOK_ID}/bookmarks/:bookmarkId`, async ({ request }) => {
      patched = (await request.json()) as Record<string, unknown>;
      const updated = { ...seededBookmark, label: '新的一章', updatedAt: new Date().toISOString() };
      items[0] = updated;
      return HttpResponse.json({ bookmark: updated });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await userEvent.click(await screen.findByRole('button', { name: '重命名' }));
  const input = screen.getByLabelText('书签备注');
  expect(input).toHaveValue('开篇');
  await userEvent.clear(input);
  await userEvent.type(input, '新的一章');
  await userEvent.click(screen.getByRole('button', { name: '保存书签' }));

  await waitFor(() => expect(patched).toMatchObject({ label: '新的一章' }));
  expect(await screen.findByRole('button', { name: '新的一章' })).toBeInTheDocument();
});

it('deletes a bookmark after confirmation', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  let deletedId: string | null = null;
  const items = [{ ...seededBookmark }];
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, pdfFile),
    http.get(`/api/books/${BOOK_ID}/bookmarks`, () => HttpResponse.json({ items })),
    http.delete(`/api/books/${BOOK_ID}/bookmarks/:bookmarkId`, ({ params }) => {
      deletedId = String(params.bookmarkId);
      items.splice(0, items.length);
      return new HttpResponse(null, { status: 204 });
    }),
  );
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await screen.findByText('开篇');
  await userEvent.click(screen.getByRole('button', { name: '删除' }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));

  await waitFor(() => expect(deletedId).toBe('bm1'));
  await waitFor(() => expect(screen.queryByTestId('bookmark-item')).not.toBeInTheDocument());
  expect(await screen.findByText('还没有书签')).toBeInTheDocument();
});
