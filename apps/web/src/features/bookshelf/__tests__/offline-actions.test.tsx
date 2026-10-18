import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { LocalAnnotationRow } from '../../../sync/types';
import { setTokens } from '../../../api/client';
import { routes } from '../../../app/router';
import type { OfflineSession } from '../../../offline/offlineContext';
import { OfflineProvider, createOfflineSession } from '../../../offline/offlineContext';
import { createMemoryStore } from '../../../offline/fileStore';
import { createSyncDb } from '../../../sync/db';
import { renderWithProviders } from '../../../../test/setup';

const USER = 'user-reader';
const BOOK = 'book-three-body';

let sequence = 0;

beforeEach(() => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
});

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
  expect(within(card).getByText('离线')).toBeInTheDocument();

  await userEvent.click(
    within(card).getByRole('button', { name: '下载到本机《三体》' }),
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
    within(card).getByRole('button', { name: '移出本机《三体》' }),
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
    within(card).getByRole('button', { name: '取消固定《三体》' }),
  );

  expect(await screen.findByText('《三体》已取消固定')).toBeInTheDocument();
  await waitFor(async () => {
    expect((await session.db.offlineBooks.get([USER, BOOK]))?.pinned).toBe(false);
  });
  expect(await session.cache.cachedUrl(USER, BOOK, 'book')).not.toBeNull();
});
