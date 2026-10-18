import { screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
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
import { createMemoryStore } from '../../../offline/fileStore';
import { OfflineProvider, createOfflineSession } from '../../../offline/offlineContext';
import type { OfflineSession } from '../../../offline/offlineContext';
import { createSyncDb } from '../../../sync/db';

const USER = 'user-reader';
const BOOK_ID = 'book-csapp';

let sequence = 0;
let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;
const sessions: OfflineSession[] = [];

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

afterEach(async () => {
  for (const session of sessions.splice(0)) {
    await session.db.delete();
  }
  delete (navigator as { onLine?: boolean }).onLine;
});

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

function createSession(): OfflineSession {
  const session = createOfflineSession({
    db: createSyncDb(`reader-shelf-snapshot-${++sequence}`),
    store: createMemoryStore(),
    fetchImpl: vi.fn(async () => new Response('cached bytes')) as unknown as typeof fetch,
  });
  sessions.push(session);
  return session;
}

function renderReader(session: OfflineSession) {
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
  const view = renderWithSync(
    <OfflineProvider session={session}>
      <RouterProvider router={router} />
    </OfflineProvider>,
    { repo, engine: syncEngine },
  );
  return { engine, view };
}

it('writes a shelf snapshot when a book opens online', async () => {
  const session = createSession();
  const { engine } = renderReader(session);

  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await waitFor(async () => {
    expect(await session.db.shelf.get([USER, BOOK_ID])).toMatchObject({
      id: BOOK_ID,
      userId: USER,
      title: '深入理解计算机系统',
      format: 'pdf',
    });
  });
});

it('opens a cold offline reader from the snapshot written by an online open', async () => {
  const session = createSession();
  const first = renderReader(session);

  await waitFor(() => expect(first.engine.open).toHaveBeenCalled());
  await waitFor(async () => {
    expect(await session.db.shelf.get([USER, BOOK_ID])).toBeDefined();
  });
  // The online open also cached the file, so the cold start has bytes to read.
  await waitFor(async () => {
    expect(await session.cache.cachedUrl(USER, BOOK_ID, 'book')).not.toBeNull();
  });
  first.view.unmount();

  // Cold start offline: the library API is unreachable and only the snapshot
  // can supply the title and format the reader needs.
  setOnline(false);
  server.use(http.get('/api/books/:id', () => HttpResponse.error()));

  const second = renderReader(session);

  await waitFor(() => expect(second.engine.open).toHaveBeenCalled());
  expect(screen.queryByText('找不到这本书')).toBeNull();
});
