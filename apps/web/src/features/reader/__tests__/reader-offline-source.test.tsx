import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
import { createMemoryStore } from '../../../offline/fileStore';
import { OfflineProvider, createOfflineSession } from '../../../offline/offlineContext';
import type { OfflineSession } from '../../../offline/offlineContext';
import { createSyncDb } from '../../../sync/db';
import { book, server } from '../../../../test/setup';
import {
  createFakeSyncEngine,
  createMemoryRepository,
} from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';
import { createFakeEngine } from './fake-engine';
import type { FakeReaderEngine } from './fake-engine';

const USER = 'user-reader';
const BOOK = 'book-csapp';

let sequence = 0;

beforeEach(() => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
});

afterEach(() => {
  // The mocked getter is an own, configurable property; removing it restores
  // jsdom's prototype getter.
  delete (navigator as { onLine?: boolean }).onLine;
});

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

function createSession(): OfflineSession {
  return createOfflineSession({
    db: createSyncDb(`reader-offline-source-${++sequence}`),
    store: createMemoryStore(),
    fetchImpl: vi.fn(
      async (input: RequestInfo | URL): Promise<Response> =>
        new Response(`bytes for ${String(input)}`),
    ) as unknown as typeof fetch,
  });
}

function renderReader(
  session: OfflineSession,
): { engine: FakeReaderEngine; repo: ReturnType<typeof createMemoryRepository> } {
  const repo = createMemoryRepository();
  const syncEngine = createFakeSyncEngine();
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: [`/books/${BOOK}/read`] },
  );
  renderWithSync(
    <OfflineProvider session={session}>
      <RouterProvider router={router} />
    </OfflineProvider>,
    { repo, engine: syncEngine },
  );
  return { engine, repo };
}

async function cacheBook(session: OfflineSession): Promise<string> {
  await session.cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.pdf');
  const url = await session.cache.cachedUrl(USER, BOOK, 'book');
  if (url === null) throw new Error('cached book URL missing');
  return url;
}

it('reports a book that was never downloaded when opening offline', async () => {
  setOnline(false);
  const session = createSession();
  const { engine } = renderReader(session);

  expect(await screen.findByText('这本书尚未下载到本机')).toBeInTheDocument();
  expect(engine.open).not.toHaveBeenCalled();
});

it('opens the downloaded copy and shows 离线 when offline', async () => {
  setOnline(false);
  const session = createSession();
  const cachedUrl = await cacheBook(session);
  const { engine } = renderReader(session);

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  expect(engine.open.mock.calls[0]?.[0]).toBe(cachedUrl);
  expect(await screen.findByText('离线')).toBeInTheDocument();
});

it('keeps the original view and explains why when switching to reflow offline', async () => {
  setOnline(false);
  const session = createSession();
  await cacheBook(session);

  let reflowRequests = 0;
  server.use(
    http.get(`/api/books/${BOOK}`, () =>
      HttpResponse.json({
        book: book({
          id: BOOK,
          title: '深入理解计算机系统',
          reflowAvailable: true,
          reflowSchemaVersion: 1,
          reflowPageCount: 300,
        }),
      }),
    ),
    http.get(`/api/books/${BOOK}/reflow`, () => {
      reflowRequests += 1;
      return HttpResponse.json({
        url: 'https://files.test/pack.bookr.json',
        schemaVersion: 1,
        pageCount: 300,
        expiresIn: 3600,
      });
    }),
  );

  const { engine } = renderReader(session);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  await userEvent.click(await screen.findByRole('button', { name: '重排' }));

  expect(
    await screen.findByText('离线时仅可阅读原版，连接网络后可切换重排'),
  ).toBeInTheDocument();
  expect(reflowRequests).toBe(0);
});

it('opens a downloaded book on a cold offline start using the shelf snapshot', async () => {
  setOnline(false);
  server.use(http.get(`/api/books/${BOOK}`, () => HttpResponse.error()));

  const session = createSession();
  const cachedUrl = await cacheBook(session);
  await session.db.shelf.put({
    id: BOOK,
    userId: USER,
    title: '深入理解计算机系统',
    author: 'Randal E. Bryant',
    format: 'pdf',
    coverUrl: null,
    updatedAt: new Date().toISOString(),
    reflowAvailable: false,
  });

  const { engine } = renderReader(session);

  expect(
    await screen.findByRole('heading', { name: '深入理解计算机系统' }),
  ).toBeInTheDocument();
  expect(screen.queryByText('找不到这本书')).toBeNull();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  expect(engine.open.mock.calls[0]?.[0]).toBe(cachedUrl);
  expect(await screen.findByText('离线')).toBeInTheDocument();
  // The snapshot says this book has no pack, so reflow stays disabled.
  expect(await screen.findByRole('button', { name: '重排' })).toBeDisabled();
});

it('offers the reflow switch offline when the snapshot remembers a pack', async () => {
  setOnline(false);
  let reflowRequests = 0;
  server.use(
    http.get(`/api/books/${BOOK}`, () => HttpResponse.error()),
    http.get(`/api/books/${BOOK}/reflow`, () => {
      reflowRequests += 1;
      return HttpResponse.json({
        url: 'https://files.test/pack.bookr.json',
        schemaVersion: 1,
        pageCount: 300,
        expiresIn: 3600,
      });
    }),
  );

  const session = createSession();
  await cacheBook(session);
  await session.db.shelf.put({
    id: BOOK,
    userId: USER,
    title: '深入理解计算机系统',
    author: 'Randal E. Bryant',
    format: 'pdf',
    coverUrl: null,
    updatedAt: new Date().toISOString(),
    reflowAvailable: true,
  });

  const { engine } = renderReader(session);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  const reflowButton = await screen.findByRole('button', { name: '重排' });
  expect(reflowButton).toBeEnabled();
  expect(reflowButton).toHaveAttribute(
    'title',
    '离线时仅可阅读原版，连接网络后可切换重排',
  );

  await userEvent.click(reflowButton);
  expect(
    await screen.findByText('离线时仅可阅读原版，连接网络后可切换重排'),
  ).toBeInTheDocument();
  expect(reflowRequests).toBe(0);
});
