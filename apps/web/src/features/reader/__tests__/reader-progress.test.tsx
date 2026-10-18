import { screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { ReaderPage } from '../ReaderPage';
import { PROGRESS_KEY_PREFIX } from '../progressStore';
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

it('opens at the locally stored locator without requesting progress over HTTP', async () => {
  repo.seedProgress(USER, BOOK_ID, { kind: 'pdf', page: 6, percent: 0.55 });
  let progressRequests = 0;
  server.use(
    http.get(`/api/books/${BOOK_ID}/progress`, () => {
      progressRequests += 1;
      return HttpResponse.json({ progress: null });
    }),
  );

  const engine = renderReader();

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({
        initialLocator: { kind: 'pdf', page: 6, percent: 0.55 },
      }),
    ),
  );
  expect(progressRequests).toBe(0);
});

it('saves progress locally and queues it for sync without calling the HTTP endpoint', async () => {
  let progressWrites = 0;
  server.use(
    http.put(`/api/books/${BOOK_ID}/progress`, () => {
      progressWrites += 1;
      return HttpResponse.json({
        progress: {
          bookId: BOOK_ID,
          locator: { kind: 'pdf', page: 3, percent: 0.3 },
          percent: 0.3,
          updatedAt: new Date().toISOString(),
        },
      });
    }),
  );

  const engine = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  engine.emit('relocated', {
    locator: { kind: 'pdf', page: 3, percent: 0.3 },
    percent: 0.3,
  });

  await waitFor(async () => {
    const row = await repo.progressFor(USER, BOOK_ID);
    expect(row?.locator).toMatchObject({ kind: 'pdf', page: 3 });
  });
  expect(await repo.pendingCount(USER)).toBeGreaterThan(0);
  expect(progressWrites).toBe(0);
});

it('migrates a legacy localStorage position once', async () => {
  const legacyKey = `${PROGRESS_KEY_PREFIX}${USER}.${BOOK_ID}`;
  localStorage.setItem(
    legacyKey,
    JSON.stringify({
      locator: { kind: 'pdf', page: 8, percent: 0.72 },
      savedAt: Date.now(),
    }),
  );

  const engine = renderReader();

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({
        initialLocator: { kind: 'pdf', page: 8, percent: 0.72 },
      }),
    ),
  );
  expect(localStorage.getItem(legacyKey)).toBeNull();

  const stored = await repo.progressFor(USER, BOOK_ID);
  expect(stored?.locator).toMatchObject({ page: 8 });
  expect(stored?.dirty).toBe(false);
  expect(repo.outbox.filter((row) => row.entityType === 'reading_progress')).toHaveLength(0);
  expect(await screen.findByRole('button', { name: '目录' })).toBeInTheDocument();
});
