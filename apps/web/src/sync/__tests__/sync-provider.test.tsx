import type { AuthTokens, Locator, MeDto, SyncPushChange } from '@bookr/shared';
import { LIBRARY_QUOTA_BYTES, MEMBER_UPLOAD_QUOTA_BYTES } from '@bookr/shared';
import { act, screen, waitFor } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { useEffect } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { AuthContextValue } from '../../app/auth';
import { useAuth } from '../../app/auth';
import { setTokens } from '../../api/client';
import { SyncStatusBadge } from '../../features/settings/SyncStatusBadge';
import { createSyncDb, type BookrDb } from '../db';
import type { SyncEngine, SyncState } from '../engine';
import { SyncProvider, useSync } from '../SyncProvider';
import type { SyncContextValue } from '../SyncProvider';
import { createRepository, type LocalRepository } from '../repository';
import { renderWithProviders, server } from '../../../test/setup';

const USER = 'user-reader';
const OTHER_USER = 'user-other';
const BOOK = '0198f0c0-0000-7000-8000-000000000001';
const locator: Locator = { kind: 'pdf', page: 3, percent: 0.25 };
const T1 = '2026-01-01T00:00:00.000Z';

const tokens: AuthTokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token-which-is-long-enough',
  expiresIn: 900,
};

let counter = 0;
let db: BookrDb;
let repo: LocalRepository;

beforeEach(() => {
  counter += 1;
  db = createSyncDb(`bookr-provider-test-${counter}`);
  repo = createRepository(db);
});

afterEach(async () => {
  vi.unstubAllGlobals();
  await db.delete();
});

function me(id: string, displayName: string): MeDto {
  return {
    id,
    username: id,
    displayName,
    role: 'member',
    timezone: 'Asia/Shanghai',
    aiEnabled: false,
    uploadUsedBytes: 0,
    uploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
    libraryUsedBytes: 0,
    libraryQuotaBytes: LIBRARY_QUOTA_BYTES,
  };
}

interface FakeEngine {
  engine: SyncEngine;
  start: ReturnType<typeof vi.fn>;
  stop: ReturnType<typeof vi.fn>;
  setState(next: SyncState): void;
}

function fakeEngine(initial: SyncState): FakeEngine {
  let listener: ((state: SyncState) => void) | null = null;
  let state = initial;
  const start = vi.fn(() => {
    listener?.(state);
  });
  const stop = vi.fn(async () => undefined);

  return {
    start,
    stop,
    setState(next) {
      state = next;
      listener?.(next);
    },
    engine: {
      start,
      stop,
      syncNow: vi.fn(async () => undefined),
      getState: () => state,
      subscribe(next) {
        listener = next;
        next(state);
        return () => {
          if (listener === next) listener = null;
        };
      },
    },
  };
}

interface ProbeHandle {
  auth: AuthContextValue;
  sync: SyncContextValue;
}

function Probe({ onReady }: { onReady: (handle: ProbeHandle) => void }) {
  const auth = useAuth();
  const sync = useSync();
  useEffect(() => {
    onReady({ auth, sync });
  });
  return null;
}

describe('SyncProvider', () => {
  it('renders 已同步 when there is nothing pending', async () => {
    setTokens(tokens);
    const fake = fakeEngine({ status: 'synced', pending: 0, lastSyncedAt: 1, conflicts: 0 });

    renderWithProviders(
      <SyncProvider createRepo={() => repo} createEngine={() => fake.engine}>
        <SyncStatusBadge />
      </SyncProvider>,
    );

    expect(await screen.findByRole('status')).toHaveTextContent('已同步');
  });

  it('renders 离线待同步 with a pending count', async () => {
    setTokens(tokens);
    const fake = fakeEngine({ status: 'offline', pending: 3, lastSyncedAt: null, conflicts: 0 });

    renderWithProviders(
      <SyncProvider createRepo={() => repo} createEngine={() => fake.engine}>
        <SyncStatusBadge />
      </SyncProvider>,
    );

    expect(await screen.findByText('离线待同步 3 项')).toBeInTheDocument();
  });

  it('starts a new engine when the user changes and stops the old one', async () => {
    let currentUser = me(USER, '读者');
    server.use(http.get('/api/auth/me', () => HttpResponse.json(currentUser)));

    const engines: FakeEngine[] = [];
    const createEngine = vi.fn((_userId: string, _repo: LocalRepository) => {
      const fake = fakeEngine({ status: 'synced', pending: 0, lastSyncedAt: null, conflicts: 0 });
      engines.push(fake);
      return fake.engine;
    });
    const handle: { current: ProbeHandle | null } = { current: null };

    renderWithProviders(
      <SyncProvider createRepo={() => repo} createEngine={createEngine}>
        <Probe
          onReady={(next) => {
            handle.current = next;
          }}
        />
      </SyncProvider>,
    );

    await act(async () => {
      await handle.current?.auth.login({ username: 'reader', password: 'correct-password' });
    });
    await waitFor(() => expect(createEngine).toHaveBeenCalledWith(USER, repo));

    currentUser = me(OTHER_USER, '林舟');
    await act(async () => {
      await handle.current?.auth.login({ username: 'reader', password: 'correct-password' });
    });

    await waitFor(() => expect(createEngine).toHaveBeenCalledWith(OTHER_USER, repo));
    expect(engines).toHaveLength(2);
    expect(engines[0]?.stop).toHaveBeenCalled();
    expect(engines[1]?.start).toHaveBeenCalled();
  });

  it('invalidates annotation queries when the engine reports an applied change', async () => {
    setTokens(tokens);
    let pullCalls = 0;
    server.use(
      http.get('/api/sync/pull', ({ request }) => {
        pullCalls += 1;
        const since = Number(new URL(request.url).searchParams.get('since') ?? '0');
        return HttpResponse.json({
          changes: [],
          cursor: Number.isFinite(since) ? since : 0,
          hasMore: false,
          reset: false,
        });
      }),
      http.post('/api/sync/push', async ({ request }) => {
        const body = (await request.json()) as { changes: SyncPushChange[] };
        return HttpResponse.json({
          applied: body.changes.map((change, index) => ({
            revision: index + 1,
            entityType: change.entityType,
            entityId: change.entityId,
            op: change.op,
            payload: {
              bookId: BOOK,
              locator,
              percent: locator.percent,
              updatedAt: T1,
              clientUpdatedAt: change.clientUpdatedAt,
            },
            clientUpdatedAt: change.clientUpdatedAt,
            serverUpdatedAt: T1,
          })),
          skipped: [],
          rejected: [],
          cursor: body.changes.length,
        });
      }),
    );

    const handle: { current: ProbeHandle | null } = { current: null };
    const { queryClient } = renderWithProviders(
      <SyncProvider>
        <Probe
          onReady={(next) => {
            handle.current = next;
          }}
        />
      </SyncProvider>,
    );
    const invalidate = vi.spyOn(queryClient, 'invalidateQueries');

    await waitFor(() => expect(pullCalls).toBeGreaterThan(0));
    await handle.current?.sync.repo.saveProgress(USER, BOOK, locator);
    await act(async () => {
      await handle.current?.sync.syncNow('test');
    });

    await waitFor(() => {
      expect(invalidate).toHaveBeenCalledWith({ queryKey: ['annotations'] });
    });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['bookmarks'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['progress'] });
    expect(invalidate).toHaveBeenCalledWith({ queryKey: ['books'] });
  });

  it('resolves the first-sync wait immediately when the engine starts offline', async () => {
    setTokens(tokens);
    // A real engine starts offline in its final state and never publishes a
    // change, so the provider must resolve the gate from the initial state.
    const offlineEngine: SyncEngine = {
      start: vi.fn(),
      stop: vi.fn(async () => undefined),
      syncNow: vi.fn(async () => undefined),
      getState: () => ({ status: 'offline', pending: 0, lastSyncedAt: null, conflicts: 0 }),
      subscribe: () => () => undefined,
    };

    const handle: { current: ProbeHandle | null } = { current: null };
    renderWithProviders(
      <SyncProvider createRepo={() => repo} createEngine={() => offlineEngine}>
        <Probe
          onReady={(next) => {
            handle.current = next;
          }}
        />
      </SyncProvider>,
    );

    await waitFor(() => expect(offlineEngine.start).toHaveBeenCalled());
    const startedAt = Date.now();
    await handle.current?.sync.waitForFirstSync(1_500);
    expect(Date.now() - startedAt).toBeLessThan(100);
  });

  it('opens the event stream through the browser EventSource', async () => {
    setTokens(tokens);
    const urls: string[] = [];

    class TestEventSource {
      constructor(url: string) {
        urls.push(url);
      }
      addEventListener(): void {}
      close(): void {}
    }

    vi.stubGlobal('EventSource', TestEventSource);
    server.use(
      http.post('/api/sync/stream-token', () =>
        HttpResponse.json({ token: 'stream-token', expiresIn: 60 }),
      ),
      http.get('/api/sync/pull', ({ request }) => {
        const since = Number(new URL(request.url).searchParams.get('since') ?? '0');
        return HttpResponse.json({
          changes: [],
          cursor: Number.isFinite(since) ? since : 0,
          hasMore: false,
          reset: false,
        });
      }),
    );

    renderWithProviders(
      <SyncProvider>
        <SyncStatusBadge />
      </SyncProvider>,
    );

    await waitFor(() => expect(urls).toHaveLength(1));
    expect(urls[0]).toContain('/api/sync/stream?token=stream-token');
  });
});
