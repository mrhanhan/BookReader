import { screen, waitFor } from '@testing-library/react';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { ReaderEngine } from '@bookr/reader-core';
import type { ReaderKind } from '@bookr/shared';
import { ReaderPage } from '../ReaderPage';
import { writeLocalProgress } from '../progressStore';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';

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
  server.use(
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
    http.get('/api/books/book-csapp/progress', () =>
      HttpResponse.json({
        progress: {
          bookId: 'book-csapp',
          locator: { kind: 'pdf', page: 2, percent: 0.42 },
          percent: 0.42,
          updatedAt: new Date().toISOString(),
        },
      }),
    ),
  );
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);

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

it('opens from the local cache when the progress request fails', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  writeLocalProgress('book-csapp', { kind: 'pdf', page: 6, percent: 0.55 }, Date.now());
  server.use(
    http.get('/api/books/book-csapp/file', () =>
      HttpResponse.json({
        url: 'https://files.test/book.pdf',
        format: 'pdf',
        expiresIn: 3600,
      }),
    ),
    http.get('/api/books/book-csapp/progress', () =>
      HttpResponse.json(
        { error: { code: 'INTERNAL', message: 'progress is down' } },
        { status: 500 },
      ),
    ),
  );
  const engine = fakeEngine();
  const factory = vi.fn(() => engine as unknown as ReaderEngine);
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={factory} /> }],
    { initialEntries: ['/books/book-csapp/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);

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
  const view = renderWithProviders(<RouterProvider router={router} />);

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
  renderWithProviders(<RouterProvider router={router} />);

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
  renderWithProviders(<RouterProvider router={router} />);

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
