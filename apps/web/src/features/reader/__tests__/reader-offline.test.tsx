import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
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

const BOOK_ID = 'book-csapp';
const USER = 'user-reader';

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function renderReader() {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get(`/api/books/${BOOK_ID}/file`, () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
  );
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  return engine;
}

it('shows annotations from the local repository while offline', async () => {
  syncEngine.setState({ status: 'offline', pending: 1, lastSyncedAt: null, conflicts: 0 });
  repo.seedAnnotation(USER, {
    id: 'offline-note',
    bookId: BOOK_ID,
    type: 'note',
    color: 'green',
    locator: { kind: 'pdf', page: 4, percent: 0.3 },
    selectedText: '离线原文',
    noteText: '离线时也能看到的批注',
    tags: [],
  });

  const engine = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '笔记' }));

  expect(await screen.findByText('离线时也能看到的批注')).toBeInTheDocument();
});

it('shows bookmarks from the local repository while offline', async () => {
  syncEngine.setState({ status: 'offline', pending: 1, lastSyncedAt: null, conflicts: 0 });
  repo.seedBookmark(USER, {
    id: 'offline-bookmark',
    bookId: BOOK_ID,
    locator: { kind: 'pdf', page: 2, percent: 0.42 },
    label: '离线书签',
  });

  const engine = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '书签' }));

  expect(await screen.findByText('离线书签')).toBeInTheDocument();
});
