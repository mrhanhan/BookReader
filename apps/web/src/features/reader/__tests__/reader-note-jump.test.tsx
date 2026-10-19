import { screen, waitFor } from '@testing-library/react';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { ReaderPage } from '../ReaderPage';
import { setTokens } from '../../../api/client';
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
const NOTE_ID = '0190f0e0-0000-7000-8000-000000000001';
const UNKNOWN_NOTE_ID = '0190f0e0-0000-7000-8000-0000000000ff';
const NOTE_LOCATOR = { kind: 'pdf' as const, page: 4, percent: 0.3 };

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function renderReader(path: string) {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = createFakeEngine();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: [path] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  return engine;
}

function seedNote(): void {
  repo.seedAnnotation(USER, {
    id: NOTE_ID,
    bookId: BOOK_ID,
    type: 'note',
    color: 'blue',
    locator: NOTE_LOCATOR,
    selectedText: '原文',
    noteText: '我的批注',
    tags: [],
  });
}

it('jumps to the note locator and flashes it', async () => {
  seedNote();
  const engine = renderReader(`/books/${BOOK_ID}/read?note=${NOTE_ID}`);

  await waitFor(() =>
    expect(engine.goTo).toHaveBeenCalledWith(NOTE_LOCATOR, { flash: true }),
  );
});

it('ignores an unknown note and warns once', async () => {
  const engine = renderReader(`/books/${BOOK_ID}/read?note=${UNKNOWN_NOTE_ID}`);

  expect(
    await screen.findByText('没有找到这条笔记，已回到上次位置'),
  ).toBeInTheDocument();
  expect(screen.getAllByText('没有找到这条笔记，已回到上次位置')).toHaveLength(1);
  expect(engine.goTo).not.toHaveBeenCalled();
  // The warning is a notice, not a blocker: the book still opened.
  expect(engine.open).toHaveBeenCalled();
});

it('does not jump without the note parameter', async () => {
  seedNote();
  const engine = renderReader(`/books/${BOOK_ID}/read`);

  // The empty highlight layer proves the annotation list already settled, so a
  // conditional jump would have run by now.
  await waitFor(() => expect(engine.setHighlights).toHaveBeenCalled());
  expect(engine.goTo).not.toHaveBeenCalled();
});
