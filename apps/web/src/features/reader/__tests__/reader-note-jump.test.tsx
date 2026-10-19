import { act, screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ReaderEngine, ReaderEngineKind } from '@bookr/reader-core';
import type { Locator } from '@bookr/shared';
import { annotationsQueryKey } from '../../../api/reading';
import { setTokens } from '../../../api/client';
import { ReaderPage } from '../ReaderPage';
import {
  createFakeSyncEngine,
  createMemoryRepository,
  type FakeSyncEngine,
  type MemoryRepository,
} from '../../../../test/memory-repository';
import { renderWithSync } from '../../../../test/sync-harness';
import { book } from '../../../../test/setup';
import { createFakeEngine, type FakeReaderEngine } from './fake-engine';

const BOOK_ID = 'book-csapp';
const OTHER_BOOK_ID = 'book-three-body';
const USER = 'user-reader';
const NOTE_ID = '0190f0e0-0000-7000-8000-000000000001';
const OTHER_NOTE_ID = '0190f0e0-0000-7000-8000-000000000002';
const UNKNOWN_NOTE_ID = '0190f0e0-0000-7000-8000-0000000000ff';
const NOTE_LOCATOR: Locator = { kind: 'pdf', page: 4, percent: 0.3 };
const OTHER_LOCATOR: Locator = { kind: 'epub', cfi: '/6/2!/4', percent: 0.55 };
const MISSING_MESSAGE = '没有找到这条笔记，已回到上次位置';

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function seedNote(bookId = BOOK_ID, id = NOTE_ID, locator: Locator = NOTE_LOCATOR): void {
  repo.seedAnnotation(USER, {
    id,
    bookId,
    type: 'note',
    color: 'blue',
    locator,
    selectedText: '原文',
    noteText: '我的批注',
    tags: [],
  });
}

function renderReader(
  path: string,
  engineFactory: (kind: ReaderEngineKind) => FakeReaderEngine,
  afterRender?: (queryClient: ReturnType<typeof renderWithSync>['queryClient']) => void,
) {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={engineFactory} /> }],
    { initialEntries: [path] },
  );
  const view = renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  if (afterRender) act(() => afterRender(view.queryClient));
  return { ...view, router };
}

/**
 * Records whether `goTo` ran before or after `open` resolved, so the jump
 * ordering can be asserted rather than inferred from call order.
 */
function trackJump(engine: FakeReaderEngine) {
  const track = { openResolved: false, goToAfterOpen: [] as boolean[] };
  const baseOpen = engine.open.getMockImplementation();
  engine.open.mockImplementation(async (...args: Parameters<ReaderEngine['open']>) => {
    const info = await baseOpen!(...args);
    track.openResolved = true;
    return info;
  });
  engine.goTo.mockImplementation(async (..._args: Parameters<ReaderEngine['goTo']>) => {
    track.goToAfterOpen.push(track.openResolved);
  });
  return track;
}

function goToCalls(engines: FakeReaderEngine[], kind?: ReaderEngineKind) {
  return engines
    .filter((engine) => kind === undefined || engine.kind === kind)
    .flatMap((engine) => engine.goTo.mock.calls);
}

it('jumps to the note locator and flashes it exactly once, after the book opens', async () => {
  seedNote();
  const engine = createFakeEngine();
  const track = trackJump(engine);
  const { router } = renderReader(`/books/${BOOK_ID}/read?note=${NOTE_ID}`, () => engine);

  await waitFor(() =>
    expect(engine.goTo).toHaveBeenCalledWith(NOTE_LOCATOR, { flash: true }),
  );
  expect(engine.goTo).toHaveBeenCalledTimes(1);
  // The order flag proves the relocation happened after `open` resolved.
  expect(track.goToAfterOpen).toEqual([true]);
  expect(router.state.location.search).toBe(`?note=${NOTE_ID}`);
});

it('accepts an uppercase note uuid', async () => {
  seedNote();
  const engine = createFakeEngine();
  renderReader(`/books/${BOOK_ID}/read?note=${NOTE_ID.toUpperCase()}`, () => engine);

  await waitFor(() =>
    expect(engine.goTo).toHaveBeenCalledWith(NOTE_LOCATOR, { flash: true }),
  );
});

it('still jumps when the annotations query is already cached before the book is ready', async () => {
  const engine = createFakeEngine();
  const { router } = renderReader(
    `/books/${BOOK_ID}/read?note=${NOTE_ID}`,
    () => engine,
    // Fill the cache while the source is still resolving: the notes are
    // available before `status` flips to ready, so the effect must rerun on
    // that transition (`status` belongs in its dependency list).
    (queryClient) => {
      queryClient.setQueryData(annotationsQueryKey(BOOK_ID), [
        {
          id: NOTE_ID,
          bookId: BOOK_ID,
          type: 'note',
          color: 'blue',
          locator: NOTE_LOCATOR,
          selectedText: '原文',
          noteText: '我的批注',
          tags: [],
          revision: 1,
          createdAt: new Date().toISOString(),
          updatedAt: new Date().toISOString(),
          userId: USER,
          clientUpdatedAt: new Date().toISOString(),
          dirty: false,
        },
      ]);
    },
  );

  await waitFor(() =>
    expect(engine.goTo).toHaveBeenCalledWith(NOTE_LOCATOR, { flash: true }),
  );
  expect(engine.goTo).toHaveBeenCalledTimes(1);
  expect(router.state.location.search).toBe(`?note=${NOTE_ID}`);
});

it('jumps on the engine of the book in the URL, not the previous book', async () => {
  seedNote(BOOK_ID, NOTE_ID, NOTE_LOCATOR);
  seedNote(OTHER_BOOK_ID, OTHER_NOTE_ID, OTHER_LOCATOR);

  const engines: FakeReaderEngine[] = [];
  const { router, queryClient } = renderReader(
    `/books/${BOOK_ID}/read?note=${NOTE_ID}`,
    (kind) => {
      const engine = createFakeEngine(kind);
      engines.push(engine);
      return engine;
    },
  );

  // First visit: a PDF engine jumps to the first book's note.
  await waitFor(() =>
    expect(goToCalls(engines, 'pdf')).toContainEqual([NOTE_LOCATOR, { flash: true }]),
  );
  const firstEngine = engines[0]!;

  // Warm the other book's metadata and notes so navigating there keeps the
  // previous engine installed for one render instead of passing through a
  // `bookId === null` frame. That is the frame where a stale-engine jump could
  // fire with the new book's note.
  await act(async () => {
    queryClient.setQueryData(
      ['book', OTHER_BOOK_ID],
      book({ id: OTHER_BOOK_ID, title: '三体', format: 'epub' }),
    );
    queryClient.setQueryData(annotationsQueryKey(OTHER_BOOK_ID), [
      {
        id: OTHER_NOTE_ID,
        bookId: OTHER_BOOK_ID,
        type: 'note',
        color: 'blue',
        locator: OTHER_LOCATOR,
        selectedText: '原文',
        noteText: '我的批注',
        tags: [],
        revision: 1,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        userId: USER,
        clientUpdatedAt: new Date().toISOString(),
        dirty: false,
      },
    ]);
  });

  await act(async () => {
    await router.navigate(`/books/${OTHER_BOOK_ID}/read?note=${OTHER_NOTE_ID}`);
  });
  await waitFor(() =>
    expect(goToCalls(engines, 'epub')).toContainEqual([OTHER_LOCATOR, { flash: true }]),
  );

  // Back to the first book: the jump runs again after the book-scoped marker
  // was cleared, and it never runs on the other book's engine.
  await act(async () => {
    await router.navigate(`/books/${BOOK_ID}/read?note=${NOTE_ID}`);
  });
  await waitFor(() =>
    expect(
      goToCalls(engines, 'pdf').filter(([locator]) => locator === NOTE_LOCATOR),
    ).toHaveLength(2),
  );

  // The engine that opened the first book only ever jumped to its own note;
  // the second book's locator never leaked into it.
  expect(firstEngine.kind).toBe('pdf');
  expect(firstEngine.goTo.mock.calls).toEqual([[NOTE_LOCATOR, { flash: true }]]);
  expect(goToCalls(engines, 'epub')).toEqual([[OTHER_LOCATOR, { flash: true }]]);
  expect(goToCalls(engines, 'pdf').every(([locator]) => locator === NOTE_LOCATOR)).toBe(true);
});

it('ignores an unknown note and warns once', async () => {
  const engine = createFakeEngine();
  // Hold the annotation list until fake timers are active, so the Toast is
  // created with a controllable dismissal timer.
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const listAnnotations = repo.listAnnotations.bind(repo);
  const listSpy = vi
    .spyOn(repo, 'listAnnotations')
    .mockImplementation(async (userId, bookId) => {
      await gate;
      return listAnnotations(userId, bookId);
    });

  try {
    const { router, queryClient } = renderReader(
      `/books/${BOOK_ID}/read?note=${UNKNOWN_NOTE_ID}`,
      () => engine,
    );
    await waitFor(() => expect(engine.open).toHaveBeenCalled());

    // Only `setTimeout` is faked so the Toast's four-second dismissal is
    // controllable while Testing Library keeps its real polling interval.
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });

    await act(async () => {
      release();
    });
    expect(screen.getByText(MISSING_MESSAGE)).toBeInTheDocument();
    expect(screen.getAllByText(MISSING_MESSAGE)).toHaveLength(1);
    expect(engine.goTo).not.toHaveBeenCalled();
    // The warning is a notice, not a blocker: the book still opened.
    expect(engine.open).toHaveBeenCalled();

    // The toast dismisses itself after four seconds...
    act(() => {
      vi.advanceTimersByTime(4_500);
    });
    expect(screen.queryByText(MISSING_MESSAGE)).not.toBeInTheDocument();

    // ...and settling the annotation list again must not warn a second time.
    await act(async () => {
      await queryClient.invalidateQueries({ queryKey: annotationsQueryKey(BOOK_ID) });
    });
    expect(screen.queryByText(MISSING_MESSAGE)).not.toBeInTheDocument();
    expect(engine.goTo).not.toHaveBeenCalled();
    expect(router.state.location.search).toBe(`?note=${UNKNOWN_NOTE_ID}`);
  } finally {
    listSpy.mockRestore();
    vi.useRealTimers();
  }
});

it('ignores a malformed note parameter silently', async () => {
  const engine = createFakeEngine();
  const { router } = renderReader(`/books/${BOOK_ID}/read?note=not-a-note-id`, () => engine);

  // The empty highlight layer proves the annotation list already settled, so
  // the missing-note branch would have run for a well-formed id.
  await waitFor(() => expect(engine.setHighlights).toHaveBeenCalled());
  expect(engine.goTo).not.toHaveBeenCalled();
  expect(screen.queryByText(MISSING_MESSAGE)).not.toBeInTheDocument();
  expect(router.state.location.search).toBe('?note=not-a-note-id');
});

it('does not jump without the note parameter', async () => {
  seedNote();
  const engine = createFakeEngine();
  const { router } = renderReader(`/books/${BOOK_ID}/read`, () => engine);

  // The empty highlight layer proves the annotation list already settled, so a
  // conditional jump would have run by now.
  await waitFor(() => expect(engine.setHighlights).toHaveBeenCalled());
  expect(engine.goTo).not.toHaveBeenCalled();
  expect(router.state.location.search).toBe('');
});
