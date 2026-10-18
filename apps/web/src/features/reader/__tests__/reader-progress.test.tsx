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

it('does not queue or buffer the position the book was opened at', async () => {
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

  // The synchronous buffer follows the same rule: the first relocation may
  // not seed a position that the open-time alignment already provided.
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  expect(localStorage.getItem(`${PROGRESS_KEY_PREFIX}${USER}.${BOOK_ID}`)).toBeNull();
});

it('flushes the throttled position to the legacy buffer synchronously on page hide', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR);
  const engine = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  const legacyKey = `${PROGRESS_KEY_PREFIX}${USER}.${BOOK_ID}`;
  const save = vi.spyOn(repo, 'saveProgress');
  const first: Locator = { kind: 'pdf', page: 7, percent: 0.66 };
  act(() => engine.emit('relocated', { locator: first, percent: first.percent }));

  // The leading write mirrors the position immediately...
  expect(JSON.parse(localStorage.getItem(legacyKey) ?? 'null')).toMatchObject({ locator: first });
  // ...and its resolution opens the five-second throttle window.
  await act(async () => {
    await new Promise((resolve) => setTimeout(resolve, 0));
  });

  // A second event inside the window only schedules a trailing Dexie write.
  localStorage.removeItem(legacyKey);
  const second: Locator = { kind: 'pdf', page: 11, percent: 0.9 };
  act(() => engine.emit('relocated', { locator: second, percent: second.percent }));
  expect(localStorage.getItem(legacyKey)).toBeNull();

  // Hold the Dexie transaction open: page hide must not wait for it.
  save.mockReturnValue(new Promise(() => {}));
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });

  expect(JSON.parse(localStorage.getItem(legacyKey) ?? 'null')).toMatchObject({ locator: second });
  save.mockRestore();
});

it('opens a reload at the newer legacy buffer and queues it for sync', async () => {
  const legacyKey = `${PROGRESS_KEY_PREFIX}${USER}.${BOOK_ID}`;
  const storedAt = Date.parse('2026-01-01T00:00:00.000Z');
  const buffered: Locator = { kind: 'pdf', page: 9, percent: 0.82 };
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR, storedAt);
  localStorage.setItem(legacyKey, JSON.stringify({ locator: buffered, savedAt: storedAt + 1_000 }));

  const engine = renderReader();

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({ initialLocator: buffered }),
    ),
  );

  expect(localStorage.getItem(legacyKey)).toBeNull();
  const stored = await repo.progressFor(USER, BOOK_ID);
  expect(stored?.locator).toEqual(buffered);
  // The buffered position is a real page turn that never reached Dexie; it is
  // written back dirty and queued so the server learns the last position.
  expect(stored?.dirty).toBe(true);
  const queued = repo.outbox.filter((row) => row.entityType === 'reading_progress');
  expect(queued).toHaveLength(1);
  expect(queued[0]?.payload).toEqual({ bookId: BOOK_ID, locator: buffered });
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

it('opens at a newer server position once the first sync lands', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR, Date.parse('2026-01-01T00:00:00.000Z'));
  syncEngine = createFakeSyncEngine({ status: 'syncing', lastSyncedAt: null });
  const engine = renderReader();

  await repo.applyServerChange(USER, progressEnvelope(NEWER_LOCATOR, '2026-01-02T00:00:00.000Z'));
  act(() => {
    syncEngine.setState({
      status: 'synced',
      pending: 0,
      lastSyncedAt: Date.now(),
      conflicts: 0,
    });
  });

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({ initialLocator: NEWER_LOCATOR }),
    ),
  );
});

it('opens at the local position without waiting when sync is offline', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR);
  syncEngine = createFakeSyncEngine({ status: 'offline', lastSyncedAt: null });
  const engine = renderReader();

  await waitFor(() =>
    expect(engine.open).toHaveBeenCalledWith(
      'https://files.test/book.pdf',
      expect.any(HTMLElement),
      expect.anything(),
      expect.objectContaining({ initialLocator: OPEN_LOCATOR }),
    ),
  );
});

it('opens at the local position when the first sync times out', async () => {
  repo.seedProgress(USER, BOOK_ID, OPEN_LOCATOR);
  syncEngine = createFakeSyncEngine({ status: 'syncing', lastSyncedAt: null });
  const engine = renderReader();

  await waitFor(
    () =>
      expect(engine.open).toHaveBeenCalledWith(
        'https://files.test/book.pdf',
        expect.any(HTMLElement),
        expect.anything(),
        expect.objectContaining({ initialLocator: OPEN_LOCATOR }),
      ),
    { timeout: 3_000 },
  );
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

it('retries a failed local write on the next hand-off', async () => {
  const engine = renderReader();
  await waitFor(() => expect(engine.open).toHaveBeenCalled());

  const save = vi.spyOn(repo, 'saveProgress').mockRejectedValue(new Error('quota exceeded'));
  const moved: Locator = { kind: 'pdf', page: 5, percent: 0.5 };
  act(() => engine.emit('relocated', { locator: moved, percent: moved.percent }));
  await waitFor(() => expect(save).toHaveBeenCalledTimes(1));

  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(2));

  save.mockResolvedValue({
    userId: USER,
    bookId: BOOK_ID,
    locator: moved,
    percent: moved.percent,
    updatedAt: new Date().toISOString(),
    clientUpdatedAt: new Date().toISOString(),
    dirty: true,
  });
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await waitFor(() => expect(save).toHaveBeenCalledTimes(3));

  // A successful hand-off clears the dirty flag, so another hide writes nothing.
  act(() => {
    window.dispatchEvent(new Event('pagehide'));
  });
  await new Promise((resolve) => setTimeout(resolve, 0));
  expect(save).toHaveBeenCalledTimes(3);

  save.mockRestore();
});
