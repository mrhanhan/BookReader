import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { ReaderEngine } from '@bookr/reader-core';
import type { MeDto, ReaderKind } from '@bookr/shared';
import { ReaderPage } from '../ReaderPage';
import { useAuth } from '../../../app/auth';
import { setTokens } from '../../../api/client';
import { server } from '../../../../test/setup';
import {
  createFakeSyncEngine,
  createMemoryRepository,
  type FakeSyncEngine,
  type MemoryRepository,
} from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function fakeEngine(kind: ReaderKind = 'pdf') {
  const listeners = new Map<string, Set<(payload: unknown) => void>>();
  return {
    kind,
    open: vi.fn(async (..._args: Parameters<ReaderEngine['open']>) => ({
      kind,
      title: '测试书',
      pageCount: kind === 'pdf' ? 10 : null,
      toc: [],
    })),
    goTo: vi.fn(async () => {}),
    goToPercent: vi.fn(async () => {}),
    next: vi.fn(async () => {}),
    previous: vi.fn(async () => {}),
    currentLocator: vi.fn(() => ({ kind: 'pdf' as const, page: 2, percent: 0.42 })),
    setSettings: vi.fn(),
    setHighlights: vi.fn(),
    on: vi.fn((event: string, listener: (payload: unknown) => void) => {
      const set = listeners.get(event) ?? new Set<(payload: unknown) => void>();
      set.add(listener);
      listeners.set(event, set);
      return () => {
        set.delete(listener);
      };
    }),
    destroy: vi.fn(async () => {}),
    emit(event: string, payload: unknown) {
      listeners.get(event)?.forEach((listener) => listener(payload));
    },
  };
}

it('opens the file at the saved locator and shows the reading chrome', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  repo.seedProgress('user-reader', 'book-csapp', { kind: 'pdf', page: 2, percent: 0.42 });
  server.use(
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
  );
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  expect(await screen.findByRole('heading', { name: '深入理解计算机系统' })).toBeInTheDocument();
  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.objectContaining({ theme: 'paper' }),
      expect.objectContaining({ initialLocator: { kind: 'pdf', page: 2, percent: 0.42 } }),
    ),
  );
  engine.emit('relocated', {
    locator: { kind: 'pdf', page: 3, percent: 0.3 },
    percent: 0.3,
  });
  expect(await screen.findByText(/第 3 \/ 10 页/)).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '目录' })).toBeInTheDocument();
});

it('opens from the local store when there is no server position', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  repo.seedProgress('user-reader', 'book-csapp', { kind: 'pdf', page: 6, percent: 0.55 });
  server.use(
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
  );
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.objectContaining({ theme: 'paper' }),
      expect.objectContaining({ initialLocator: { kind: 'pdf', page: 6, percent: 0.55 } }),
    ),
  );
});

it('destroys the engine when the reader unmounts', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  const view = renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  view.unmount();
  await waitFor(() => expect(engine.destroy).toHaveBeenCalledTimes(1));
});

it('passes pdf.js worker and asset URLs when opening a PDF', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = fakeEngine('pdf');
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  const options = engine.open.mock.calls[0]?.[3] as Record<string, unknown>;
  expect(options.cMapUrl).toBe('/cmaps/');
  expect(options.standardFontDataUrl).toBe('/standard_fonts/');
  expect(typeof options.workerSrc).toBe('string');
  expect(String(options.workerSrc).length).toBeGreaterThan(0);
});

it('omits pdf.js resources when opening an EPUB', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = fakeEngine('epub');
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-three-body/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.epub',
      expect.any(HTMLElement),
      expect.anything(),
      expect.anything(),
    ),
  );
  const options = engine.open.mock.calls[0]?.[3] as Record<string, unknown>;
  expect('workerSrc' in options).toBe(false);
  expect('cMapUrl' in options).toBe(false);
  expect('standardFontDataUrl' in options).toBe(false);
});

it('shows the file error and does not open the engine when the file request fails', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  server.use(
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json(
        { error: { code: 'FILE_MISSING', message: 'file is missing' } },
        { status: 404 },
      ),
    ),
  );
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  expect(await screen.findByText('找不到这本书的文件')).toBeInTheDocument();
  expect(engine.open).not.toHaveBeenCalled();
});

it('does not open a second account at the first account cached position', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });

  const accountA: MeDto = {
    id: 'user-reader',
    username: 'reader',
    displayName: '读者',
    role: 'member',
    timezone: 'Asia/Shanghai',
    aiEnabled: false,
    uploadUsedBytes: 0,
    uploadQuotaBytes: 1024 * 1024 * 1024,
    libraryUsedBytes: 0,
    libraryQuotaBytes: 10 * 1024 * 1024 * 1024,
  };
  const accountB: MeDto = {
    ...accountA,
    id: 'user-second',
    username: 'second-reader',
    displayName: '第二读者',
  };

  let activeUser = accountA;
  server.use(
    http.get('/api/auth/me', () => HttpResponse.json(activeUser)),
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
  );

  // Account A has page 7 in the local store; account B has none.
  repo.seedProgress('user-reader', 'book-csapp', { kind: 'pdf', page: 7, percent: 0.6 });

  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);

  function AccountSwitcher() {
    const { login } = useAuth();
    return (
      <button
        type="button"
        onClick={() => {
          void login({ username: 'reader', password: 'correct-password' });
        }}
      >
        切换账号
      </button>
    );
  }

  const router = createMemoryRouter(
    [
      {
        path: '/books/:id/read',
        element: (
          <>
            <ReaderPage engineFactory={factory} />
            <AccountSwitcher />
          </>
        ),
      },
    ],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({ initialLocator: { kind: 'pdf', page: 7, percent: 0.6 } }),
    ),
  );

  activeUser = accountB;
  await userEvent.click(screen.getByRole('button', { name: '切换账号' }));

  await waitFor(() => expect(engine.open.mock.calls.length).toBeGreaterThanOrEqual(2));
  const lastOptions = engine.open.mock.calls.at(-1)?.[3] as {
    initialLocator?: unknown;
  };
  // B has no cached or server position, so A's page 7 must not be reused.
  expect(lastOptions.initialLocator).toBeUndefined();
});
