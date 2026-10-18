import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { CachedShelfBook, LocalAnnotationRow } from '../../../sync/types';
import { setTokens } from '../../../api/client';
import { routes } from '../../../app/router';
import type { OfflineSession } from '../../../offline/offlineContext';
import { OfflineProvider, createOfflineSession } from '../../../offline/offlineContext';
import { createMemoryStore } from '../../../offline/fileStore';
import { createSyncDb } from '../../../sync/db';
import { renderWithProviders, book, server } from '../../../../test/setup';

const USER = 'user-reader';
const BOOK = 'book-three-body';

let sequence = 0;

beforeEach(() => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
});

afterEach(() => {
  delete (navigator as { onLine?: boolean }).onLine;
});

function setOnline(value: boolean): void {
  Object.defineProperty(navigator, 'onLine', { configurable: true, get: () => value });
}

function createSession(): OfflineSession {
  const db = createSyncDb(`offline-actions-${++sequence}`);
  const fetchImpl = vi.fn(
    async (input: RequestInfo | URL): Promise<Response> =>
      new Response(`bytes for ${String(input)}`),
  );
  return createOfflineSession({
    db,
    store: createMemoryStore(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function shelfRow(
  overrides: Partial<CachedShelfBook> & Pick<CachedShelfBook, 'id' | 'userId' | 'title'>,
): CachedShelfBook {
  return {
    author: null,
    format: 'epub',
    coverUrl: null,
    updatedAt: new Date().toISOString(),
    reflowAvailable: false,
    deletedAt: null,
    ...overrides,
  };
}

function renderShelf(session: OfflineSession) {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  return renderWithProviders(
    <OfflineProvider session={session}>
      <RouterProvider router={router} />
    </OfflineProvider>,
  );
}

async function cardFor(title: string): Promise<HTMLElement> {
  const heading = await screen.findByText(title);
  return heading.closest('[data-testid="book-card"]') as HTMLElement;
}

it('shows 离线 on a cached book and pins it from the menu', async () => {
  const session = createSession();
  await session.cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');

  renderShelf(session);

  const card = await cardFor('三体');
  expect(await within(card).findByText('离线')).toBeInTheDocument();

  await userEvent.click(
    await within(card).findByRole('button', { name: '下载到本机《三体》' }),
  );

  await waitFor(async () => {
    expect((await session.db.offlineBooks.get([USER, BOOK]))?.pinned).toBe(true);
  });
  expect(
    await screen.findByRole('button', { name: '取消固定《三体》' }),
  ).toBeInTheDocument();
  expect(await screen.findByText('《三体》已下载到本机，可离线阅读')).toBeInTheDocument();
});

it('only offers 下载到本机 for a book that is not on this device', async () => {
  const session = createSession();
  renderShelf(session);

  const card = await cardFor('三体');
  expect(within(card).queryByText('离线')).toBeNull();
  expect(within(card).queryByRole('button', { name: '移出本机《三体》' })).toBeNull();
  expect(
    within(card).getByRole('button', { name: '下载到本机《三体》' }),
  ).toBeInTheDocument();
});

it('removing a cached book keeps its annotations', async () => {
  const session = createSession();
  await session.cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');

  const timestamp = new Date().toISOString();
  const annotation: LocalAnnotationRow = {
    id: 'annotation-1',
    bookId: BOOK,
    type: 'highlight',
    color: 'yellow',
    locator: { kind: 'pdf', page: 3, percent: 0.25 },
    selectedText: '值得记下的一句',
    noteText: '离线前后都要保留的批注',
    tags: [],
    revision: 1,
    createdAt: timestamp,
    updatedAt: timestamp,
    userId: USER,
    clientUpdatedAt: timestamp,
    dirty: false,
  };
  await session.db.annotations.put(annotation);

  renderShelf(session);

  const card = await cardFor('三体');
  await userEvent.click(
    await within(card).findByRole('button', { name: '移出本机《三体》' }),
  );

  expect(await screen.findByText('《三体》已移出本机')).toBeInTheDocument();
  await waitFor(async () => {
    expect(await session.db.offlineBooks.get([USER, BOOK])).toBeUndefined();
  });
  // Eviction removes bytes only; reading data is never touched.
  expect(await session.db.annotations.get('annotation-1')).toEqual(annotation);
});

it('unpins a pinned book without deleting its copy', async () => {
  const session = createSession();
  await session.cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');
  await session.cache.pin(USER, BOOK);

  renderShelf(session);

  const card = await cardFor('三体');
  await userEvent.click(
    await within(card).findByRole('button', { name: '取消固定《三体》' }),
  );

  expect(await screen.findByText('《三体》已取消固定')).toBeInTheDocument();
  await waitFor(async () => {
    expect((await session.db.offlineBooks.get([USER, BOOK]))?.pinned).toBe(false);
  });
  expect(await session.cache.cachedUrl(USER, BOOK, 'book')).not.toBeNull();
});

it('writes the shelf snapshot after a successful load', async () => {
  const session = createSession();
  renderShelf(session);

  await cardFor('三体');

  await waitFor(async () => {
    expect(await session.db.shelf.get([USER, BOOK])).toMatchObject({
      userId: USER,
      title: '三体',
      author: '刘慈欣',
      format: 'epub',
    });
  });
  // Only `CachedShelfBook` fields are stored; reading data stays in its tables.
  const row = await session.db.shelf.get([USER, BOOK]);
  expect(Object.keys(row ?? {}).sort()).toEqual([
    'author',
    'coverUrl',
    'deletedAt',
    'format',
    'id',
    'reflowAvailable',
    'title',
    'updatedAt',
    'userId',
  ]);
});

it('remembers reflow availability in the shelf snapshot', async () => {
  const session = createSession();
  server.use(
    http.get('/api/books', () =>
      HttpResponse.json({
        items: [
          book({
            id: 'book-reflowable',
            title: '可重排的书',
            format: 'pdf',
            reflowAvailable: true,
            reflowSchemaVersion: 1,
            reflowPageCount: 300,
          }),
        ],
        total: 1,
        page: 1,
        pageSize: 24,
      }),
    ),
  );

  renderShelf(session);

  expect(await screen.findByText('可重排的书')).toBeInTheDocument();
  await waitFor(async () => {
    expect(
      (await session.db.shelf.get([USER, 'book-reflowable']))?.reflowAvailable,
    ).toBe(true);
  });
});

it('renders the cached shelf on a cold offline start', async () => {
  const session = createSession();
  await session.db.shelf.put({
    id: BOOK,
    userId: USER,
    title: '三体',
    author: '刘慈欣',
    format: 'epub',
    coverUrl: null,
    updatedAt: new Date().toISOString(),
    reflowAvailable: false,
    deletedAt: null,
  });
  await session.cache.cacheFromUrl(USER, BOOK, 'book', 'https://files.test/cached.epub');
  server.use(http.get('/api/books', () => HttpResponse.error()));
  setOnline(false);

  renderShelf(session);

  expect(await screen.findByText('当前离线，显示本机缓存的书架。')).toBeInTheDocument();
  const card = await cardFor('三体');
  expect(await within(card).findByText('离线')).toBeInTheDocument();
  expect(within(card).getByRole('link', { name: '阅读《三体》' })).toHaveAttribute(
    'href',
    `/books/${BOOK}/read`,
  );
});

it('keeps shelf snapshots per account', async () => {
  const session = createSession();
  // Another account already cached the same book id with different metadata.
  await session.db.shelf.put(
    shelfRow({ id: BOOK, userId: 'user-other', title: '三体（他人快照）' }),
  );

  renderShelf(session);
  await cardFor('三体');

  await waitFor(async () => {
    expect((await session.db.shelf.get([USER, BOOK]))?.title).toBe('三体');
  });
  // Loading the shelf must not overwrite another account's snapshot.
  expect((await session.db.shelf.get(['user-other', BOOK]))?.title).toBe(
    '三体（他人快照）',
  );
});

it('shows only the current account snapshot when offline', async () => {
  const session = createSession();
  await session.db.shelf.put(
    shelfRow({ id: 'book-shared', userId: USER, title: '我的缓存书' }),
  );
  await session.db.shelf.put(
    shelfRow({ id: 'book-shared', userId: 'user-other', title: '他人的缓存书' }),
  );
  server.use(http.get('/api/books', () => HttpResponse.error()));
  setOnline(false);

  renderShelf(session);

  expect(await screen.findByText('我的缓存书')).toBeInTheDocument();
  expect(screen.queryByText('他人的缓存书')).toBeNull();
});

it('prunes snapshots for books that left the shelf', async () => {
  const session = createSession();
  await session.db.shelf.put(
    shelfRow({ id: 'book-removed', userId: USER, title: '已经不在书架上的书' }),
  );

  renderShelf(session);
  await cardFor('三体');

  // A complete, unfiltered load is authoritative for this account.
  await waitFor(async () => {
    expect(await session.db.shelf.get([USER, 'book-removed'])).toBeUndefined();
  });
  expect(await session.db.shelf.get([USER, BOOK])).toBeDefined();
});

it('removes the snapshot when a book is deleted', async () => {
  const session = createSession();
  renderShelf(session);

  await cardFor('深入理解计算机系统');
  await waitFor(async () => {
    expect(await session.db.shelf.get([USER, 'book-csapp'])).toBeDefined();
  });

  await userEvent.click(
    await screen.findByRole('button', { name: '删除《深入理解计算机系统》' }),
  );
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(await screen.findByText('已移入回收站')).toBeInTheDocument();

  await waitFor(async () => {
    expect(await session.db.shelf.get([USER, 'book-csapp'])).toBeUndefined();
  });
});

it('hides trashed snapshot rows from the offline shelf', async () => {
  const session = createSession();
  await session.db.shelf.put(
    shelfRow({
      id: 'book-trashed',
      userId: USER,
      title: '已经进回收站的书',
      deletedAt: new Date().toISOString(),
    }),
  );
  server.use(http.get('/api/books', () => HttpResponse.error()));
  setOnline(false);

  renderShelf(session);

  expect(
    await screen.findByText('当前离线，书架也还没有同步到本机。'),
  ).toBeInTheDocument();
  expect(screen.queryByText('已经进回收站的书')).toBeNull();
});
