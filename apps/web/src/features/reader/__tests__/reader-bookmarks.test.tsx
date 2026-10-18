import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { bookmarkTitle } from '../BookmarksPanel';
import { setTokens } from '../../../api/client';
import { server } from '../../../../test/setup';
import {
  createFakeSyncEngine,
  createMemoryRepository,
  type FakeSyncEngine,
  type MemoryRepository,
} from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';
import { createFakeEngine } from './fake-engine';
import type { FakeReaderEngine } from './fake-engine';

const BOOK_ID = 'book-csapp';
const USER = 'user-reader';
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

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function renderReader(engine: FakeReaderEngine = createFakeEngine()) {
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  server.use(http.get(`/api/books/${BOOK_ID}/file`, pdfFile));
  const view = renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  return { engine, ...view };
}

it('creates a bookmark at the current position and jumps to it', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await userEvent.click(await screen.findByRole('button', { name: '添加书签' }));
  await userEvent.type(screen.getByLabelText('书签备注'), '第二页');
  await userEvent.click(screen.getByRole('button', { name: '保存书签' }));

  await waitFor(async () => {
    const rows = await repo.listBookmarks(USER, BOOK_ID);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({ locator: LOCATOR, label: '第二页', dirty: true });
  });
  expect(repo.outbox.some((row) => row.entityType === 'bookmark' && row.op === 'upsert')).toBe(
    true,
  );

  const label = await screen.findByRole('button', { name: '第二页' });
  expect(screen.getByTestId('bookmark-item')).toBeInTheDocument();

  await userEvent.click(label);
  expect(engine.goTo).toHaveBeenCalledWith(LOCATOR, { flash: true });
});

it('renames a bookmark from the panel', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  repo.seedBookmark(USER, seededBookmark);
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await userEvent.click(await screen.findByRole('button', { name: /^重命名：/ }));
  const input = screen.getByLabelText('书签备注');
  expect(input).toHaveValue('开篇');
  await userEvent.clear(input);
  await userEvent.type(input, '新的一章');
  await userEvent.click(screen.getByRole('button', { name: '保存书签' }));

  await waitFor(async () => {
    const rows = await repo.listBookmarks(USER, BOOK_ID);
    expect(rows[0]).toMatchObject({ label: '新的一章', dirty: true });
  });
  expect(await screen.findByRole('button', { name: '新的一章' })).toBeInTheDocument();
});

it('deletes a bookmark after confirmation', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  repo.seedBookmark(USER, seededBookmark);
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await screen.findByText('开篇');
  await userEvent.click(screen.getByRole('button', { name: /^删除：/ }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));

  await waitFor(async () => {
    expect(await repo.listBookmarks(USER, BOOK_ID)).toEqual([]);
  });
  expect(repo.outbox.some((row) => row.entityType === 'bookmark' && row.op === 'delete')).toBe(
    true,
  );
  await waitFor(() => expect(screen.queryByTestId('bookmark-item')).not.toBeInTheDocument());
  expect(await screen.findByText('还没有书签')).toBeInTheDocument();
});

it('stores a null label when the bookmark note is blank', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const { engine } = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));
  await userEvent.click(await screen.findByRole('button', { name: '添加书签' }));
  await userEvent.click(screen.getByRole('button', { name: '保存书签' }));

  await waitFor(async () => {
    const rows = await repo.listBookmarks(USER, BOOK_ID);
    expect(rows[0]).toMatchObject({ locator: LOCATOR, label: null });
  });
});

it('labels bookmarks by page for PDF and reflow, by percent for EPUB', () => {
  const base = {
    id: 'bookmark-title',
    bookId: BOOK_ID,
    label: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  };

  expect(bookmarkTitle({ ...base, locator: { kind: 'pdf', page: 3, percent: 0.3 } })).toBe(
    '第 3 页',
  );
  expect(
    bookmarkTitle({ ...base, locator: { kind: 'reflow', sourcePage: 5, percent: 0.4 } }),
  ).toBe('第 5 页');
  expect(
    bookmarkTitle({ ...base, locator: { kind: 'epub', cfi: 'epubcfi(/6/2)', percent: 0.426 } }),
  ).toBe('位置 43%');
});
