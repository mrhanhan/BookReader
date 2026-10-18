import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import type { ReactNode } from 'react';
import { http, HttpResponse } from 'msw';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import type { MeDto } from '@bookr/shared';
import { ReaderPage } from '../ReaderPage';
import { READER_SETTINGS_KEY } from '../readerSettings';
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
import { createFakeEngine } from './fake-engine';

const USER = 'user-reader';
const BOOK_ID = 'book-csapp';

let repo: MemoryRepository;
let syncEngine: FakeSyncEngine;

beforeEach(() => {
  repo = createMemoryRepository();
  syncEngine = createFakeSyncEngine();
});

function seedSettings(userId: string, settings: Record<string, unknown>): void {
  repo.settingsRows.set(userId, {
    userId,
    settings,
    clientUpdatedAt: new Date().toISOString(),
    dirty: false,
  });
}

function renderReader(extra?: ReactNode) {
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
    [
      {
        path: '/books/:id/read',
        element: (
          <>
            <ReaderPage engineFactory={() => engine} />
            {extra}
          </>
        ),
      },
    ],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  renderWithSync(<RouterProvider router={router} />, { repo, engine: syncEngine });
  return engine;
}

it('opens with settings that were pulled into the account repository', async () => {
  seedSettings(USER, { ...DEFAULT_READER_SETTINGS, theme: 'dark' });

  const engine = renderReader();

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  // The settings document is read after the open's sync, before the engine is
  // opened, so the very first paint already uses the synced theme.
  expect(engine.open.mock.calls[0]?.[2]).toMatchObject({ theme: 'dark' });
  await waitFor(() =>
    expect(document.querySelector('.reader-root')).toHaveAttribute(
      'data-reader-theme',
      'dark',
    ),
  );
});

it('migrates the legacy global settings into the account and clears the key', async () => {
  localStorage.setItem(
    READER_SETTINGS_KEY,
    JSON.stringify({ theme: 'sepia', epub: { fontSize: 21 } }),
  );

  const engine = renderReader();

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  expect(engine.open.mock.calls[0]?.[2]).toMatchObject({ theme: 'sepia' });

  await waitFor(() => {
    expect(repo.settingsRows.get(USER)?.settings).toMatchObject({
      theme: 'sepia',
      epub: expect.objectContaining({ fontSize: 21 }),
    });
  });
  // The migrated document is queued so the server receives it, and the global
  // key is gone so another account on this browser cannot inherit it.
  expect(
    repo.outbox.filter((row) => row.entityType === 'reader_settings'),
  ).toHaveLength(1);
  await waitFor(() => expect(localStorage.getItem(READER_SETTINGS_KEY)).toBeNull());
});

it('does not leak one account settings into the next', async () => {
  const accountA: MeDto = {
    id: USER,
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
  seedSettings(USER, { ...DEFAULT_READER_SETTINGS, theme: 'dark' });

  let activeUser = accountA;
  server.use(http.get('/api/auth/me', () => HttpResponse.json(activeUser)));

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

  const engine = renderReader(<AccountSwitcher />);
  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  expect(engine.open.mock.calls[0]?.[2]).toMatchObject({ theme: 'dark' });

  activeUser = accountB;
  await userEvent.click(screen.getByRole('button', { name: '切换账号' }));

  // Account B never saved settings, so the reader must fall back to the
  // defaults instead of keeping account A's document in memory.
  await waitFor(() => expect(engine.open.mock.calls.length).toBeGreaterThanOrEqual(2));
  const lastSettings = engine.open.mock.calls.at(-1)?.[2];
  expect(lastSettings).toMatchObject({ theme: DEFAULT_READER_SETTINGS.theme });
  expect(
    repo.outbox.filter(
      (row) => row.entityType === 'reader_settings' && row.userId === 'user-second',
    ),
  ).toHaveLength(0);
});
