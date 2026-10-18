import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { Locator, SyncChangeEnvelope } from '@bookr/shared';
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

const OPEN_LOCATOR: Locator = { kind: 'pdf', page: 6, percent: 0.55 };
const NEWER_LOCATOR: Locator = { kind: 'pdf', page: 9, percent: 0.82 };

function progressEnvelope(locator: Locator, at: string): SyncChangeEnvelope {
  return {
    revision: 1,
    entityType: 'reading_progress',
    entityId: BOOK_ID,
    op: 'upsert',
    payload: {
      bookId: BOOK_ID,
      locator,
      percent: locator.percent,
      updatedAt: at,
      clientUpdatedAt: at,
    },
    clientUpdatedAt: at,
    serverUpdatedAt: at,
  };
}

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

it('does not queue the position the book was opened at', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR);
  const engine = renderReader();

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({ initialLocator: OPEN_LOCATOR }),
    ),
  );

  act(() => engine.emit('relocated', { locator: OPEN_LOCATOR, percent: OPEN_LOCATOR.percent }));

  await waitFor(() => expect(repo.outbox).toHaveLength(0));
  expect((await repo.progressFor(USER, BOOK_ID))?.locator).toEqual(OPEN_LOCATOR);
});

it('does not overwrite progress applied from the server before the first write', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR);
  const engine = renderReader();

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  act(() => engine.emit('relocated', { locator: OPEN_LOCATOR, percent: OPEN_LOCATOR.percent }));
  await waitFor(() => expect(repo.outbox).toHaveLength(0));

  const outcome = await repo.applyServerChange(
    USER,
    progressEnvelope(NEWER_LOCATOR, '2026-01-02T00:00:00.000Z'),
  );

  expect(outcome).toBe('applied');
  expect((await repo.progressFor(USER, BOOK_ID))?.locator).toEqual(NEWER_LOCATOR);
  expect(repo.outbox).toHaveLength(0);
});

it('jumps to a newer server progress applied while the book is open', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR);
  const engine = renderReader();

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await screen.findByRole('button', { name: '目录' });

  await repo.applyServerChange(USER, progressEnvelope(NEWER_LOCATOR, '2026-01-02T00:00:00.000Z'));
  act(() => {
    syncEngine.setState({
      status: 'synced',
      pending: 0,
      lastSyncedAt: null,
      conflicts: 0,
      lastApplied: {
        entityType: 'reading_progress',
        entityId: BOOK_ID,
        at: 1,
        source: 'pull',
      },
    });
  });

  await waitFor(() => expect(engine.goTo).toHaveBeenCalledWith(NEWER_LOCATOR));
});

it('keeps reading when the local progress write fails', async () => {
  const engine = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  const failing = vi.spyOn(repo, 'saveProgress').mockRejectedValue(new Error('quota exceeded'));
  const moved: Locator = { kind: 'pdf', page: 4, percent: 0.4 };
  act(() => engine.emit('relocated', { locator: moved, percent: moved.percent }));

  await waitFor(() => expect(failing).toHaveBeenCalled());
  expect(await screen.findByRole('button', { name: '目录' })).toBeInTheDocument();
  failing.mockRestore();
});
