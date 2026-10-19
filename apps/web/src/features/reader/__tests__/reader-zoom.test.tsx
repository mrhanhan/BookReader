import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import type { ReaderSettings } from '@bookr/reader-core';
import { ReaderPage } from '../ReaderPage';
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

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

async function renderReader(
  bookId = 'book-csapp',
  settings?: ReaderSettings,
): Promise<ReturnType<typeof createFakeEngine>> {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  if (settings) {
    repo.settingsRows.set('user-reader', {
      userId: 'user-reader',
      settings: { ...settings },
      clientUpdatedAt: new Date().toISOString(),
      dirty: false,
    });
  }
  server.use(
    http.get(`/api/books/${bookId}/file`, () =>
      HttpResponse.json({
        url: `https://files.test/${bookId}.pdf`,
        format: bookId === 'book-three-body' ? 'epub' : 'pdf',
        expiresIn: 3600,
      }),
    ),
  );
  const engine = createFakeEngine(bookId === 'book-three-body' ? 'epub' : 'pdf');
  const router = createMemoryRouter(
    [
      {
        path: '/books/:id/read',
        element: <ReaderPage engineFactory={() => engine} />,
      },
    ],
    { initialEntries: [`/books/${bookId}/read`] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  await screen.findByRole('button', { name: '目录' });
  return engine;
}

function storedZoom(): unknown {
  const pdf = repo.settingsRows.get('user-reader')?.settings['pdf'];
  if (typeof pdf !== 'object' || pdf === null) return null;
  return (pdf as { zoom?: unknown }).zoom ?? null;
}

function tapAt(target: HTMLElement, clientX: number, clientY: number): void {
  fireEvent.touchStart(target, { touches: [{ clientX, clientY }] });
  fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX, clientY }] });
}

function swipe(target: HTMLElement, fromX: number, toX: number, y: number): void {
  fireEvent.touchStart(target, { touches: [{ clientX: fromX, clientY: y }] });
  fireEvent.touchEnd(target, { touches: [], changedTouches: [{ clientX: toX, clientY: y }] });
}

it('shows zoom controls for a PDF and applies each button', async () => {
  const engine = await renderReader();

  expect(screen.getByLabelText('缩放比例')).toHaveTextContent('100%');

  await userEvent.click(screen.getByRole('button', { name: '放大' }));
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 1.2 }) }),
  );
  expect(screen.getByLabelText('缩放比例')).toHaveTextContent('120%');

  await userEvent.click(screen.getByRole('button', { name: '缩小' }));
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 1 }) }),
  );
  expect(screen.getByLabelText('缩放比例')).toHaveTextContent('100%');

  await userEvent.click(screen.getByRole('button', { name: '适应宽度' }));
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 'fit-width' }) }),
  );
  await waitFor(() => expect(storedZoom()).toBe('fit-width'));
});

it('zooms to 2x on a double tap of the reading surface', async () => {
  const engine = await renderReader();
  const content = screen.getByTestId('reader-content');

  tapAt(content, 120, 160);
  tapAt(content, 121, 160);

  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 2 }) }),
  );
  expect(screen.getByLabelText('缩放比例')).toHaveTextContent('200%');

  // A second double tap while zoomed in returns to fit-width.
  tapAt(content, 120, 160);
  tapAt(content, 121, 160);
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 'fit-width' }) }),
  );
});

it('turns pages with a horizontal swipe in single-page PDF mode', async () => {
  const engine = await renderReader('book-csapp', {
    ...DEFAULT_READER_SETTINGS,
    pdf: { ...DEFAULT_READER_SETTINGS.pdf, mode: 'single' },
  });
  const content = screen.getByTestId('reader-content');

  // Leftward swipe goes forward, rightward goes back.
  swipe(content, 240, 120, 120);
  expect(engine.next).toHaveBeenCalledTimes(1);
  swipe(content, 120, 240, 120);
  expect(engine.previous).toHaveBeenCalledTimes(1);

  // An open panel owns the gesture, so the page must not turn.
  await userEvent.click(screen.getByRole('button', { name: '目录' }));
  swipe(content, 240, 120, 120);
  expect(engine.next).toHaveBeenCalledTimes(1);
});

it('supports +, - and 0 zoom shortcuts', async () => {
  const engine = await renderReader();

  await userEvent.keyboard('+');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 1.2 }) }),
  );

  await userEvent.keyboard('-');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 1 }) }),
  );

  await userEvent.keyboard('+');
  await userEvent.keyboard('0');
  expect(engine.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ pdf: expect.objectContaining({ zoom: 'fit-width' }) }),
  );
});

it('hides zoom controls for an EPUB', async () => {
  await renderReader('book-three-body');

  expect(screen.queryByLabelText('缩放比例')).toBeNull();
  expect(screen.queryByRole('button', { name: '放大' })).toBeNull();
  expect(screen.queryByRole('button', { name: '缩小' })).toBeNull();
  expect(screen.queryByRole('button', { name: '适应宽度' })).toBeNull();
});
