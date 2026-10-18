import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { formatDateTime } from '../../../lib/format';
import { setTokens } from '../../../api/client';
import type { DeviceItem } from '../../../api/devices';
import { routes } from '../../../app/router';
import { createMemoryStore } from '../../../offline/fileStore';
import { OfflineProvider, createOfflineSession } from '../../../offline/offlineContext';
import type { OfflineSession } from '../../../offline/offlineContext';
import { createSyncDb } from '../../../sync/db';
import type { SyncEngine, SyncState } from '../../../sync/engine';
import { createMemoryRepository } from '../../../../test/memory-repository';
import { server } from '../../../../test/setup';
import { renderWithSync } from '../../../../test/sync-harness';

const USER = 'user-reader';
const BOOK_THREE_BODY = 'book-three-body';
const BOOK_CSAPP = 'book-csapp';

const DEFAULT_STATE: SyncState = {
  status: 'synced',
  pending: 0,
  lastSyncedAt: null,
  conflicts: 0,
};

let sequence = 0;

beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
  // The settings page always loads devices; individual tests override this.
  server.use(http.get('/api/devices', () => HttpResponse.json({ items: [] })));
});

function createEngine(state: SyncState = DEFAULT_STATE) {
  const syncNow = vi.fn(async () => undefined);
  const engine: SyncEngine = {
    start: () => undefined,
    stop: async () => undefined,
    syncNow,
    getState: () => state,
    subscribe: () => () => undefined,
  };
  return { engine, syncNow };
}

/** A fresh offline session backed by a unique database and the memory store. */
function createSession(): OfflineSession {
  const db = createSyncDb(`settings-${++sequence}`);
  const fetchImpl = vi.fn(async (input: RequestInfo | URL): Promise<Response> => {
    const size = String(input).includes('large') ? 4096 : 2048;
    return new Response(new ArrayBuffer(size));
  });
  return createOfflineSession({
    db,
    store: createMemoryStore(),
    fetchImpl: fetchImpl as unknown as typeof fetch,
  });
}

function renderSettings(engine: SyncEngine, session: OfflineSession = createSession()) {
  const router = createMemoryRouter(routes, { initialEntries: ['/settings'] });
  renderWithSync(
    <OfflineProvider session={session}>
      <RouterProvider router={router} />
    </OfflineProvider>,
    { repo: createMemoryRepository(), engine },
  );
  return session;
}

it('shows the sync state and lets the user sync now', async () => {
  const lastSyncedAt = Date.UTC(2026, 9, 18, 9, 30);
  const { engine, syncNow } = createEngine({
    status: 'pending',
    pending: 3,
    lastSyncedAt,
    conflicts: 0,
  });

  renderSettings(engine);

  expect(await screen.findByRole('heading', { name: '设置' })).toBeInTheDocument();
  // The badge is also in the app header, so assert inside the sync section.
  const syncSection = await screen.findByRole('region', { name: '同步' });
  expect(await within(syncSection).findByText('待同步 3 项')).toBeInTheDocument();
  expect(within(syncSection).getByText('3 项')).toBeInTheDocument();
  expect(
    within(syncSection).getByText(formatDateTime(new Date(lastSyncedAt).toISOString())),
  ).toBeInTheDocument();

  await userEvent.click(within(syncSection).getByRole('button', { name: '立即同步' }));
  expect(syncNow).toHaveBeenCalledTimes(1);
});

it('surfaces a sync failure', async () => {
  const { engine } = createEngine({
    status: 'error',
    pending: 2,
    lastSyncedAt: null,
    conflicts: 0,
  });

  renderSettings(engine);

  const syncSection = await screen.findByRole('region', { name: '同步' });
  expect(await within(syncSection).findByRole('alert')).toHaveTextContent(
    '同步失败，请检查网络后重试。',
  );
});

it('lists cached books with sizes and clears unpinned ones', async () => {
  const session = createSession();
  await session.cache.cacheFromUrl(
    USER,
    BOOK_THREE_BODY,
    'book',
    'https://files.test/small.epub',
  );
  await session.cache.cacheFromUrl(USER, BOOK_CSAPP, 'book', 'https://files.test/large.epub');
  await session.cache.pin(USER, BOOK_CSAPP);

  const { engine } = createEngine();
  renderSettings(engine, session);

  // Titles come from the book API; the sizes come from the local cache rows.
  expect(await screen.findByText('三体')).toBeInTheDocument();
  expect(screen.getByText('深入理解计算机系统')).toBeInTheDocument();
  expect(screen.getByText('EPUB · 2 KB')).toBeInTheDocument();
  expect(screen.getByText('PDF · 4 KB')).toBeInTheDocument();
  expect(screen.getByText(/已用 6 KB/)).toBeInTheDocument();
  expect(
    screen.getByRole('switch', { name: '固定《深入理解计算机系统》' }),
  ).toHaveAttribute('aria-checked', 'true');

  await userEvent.click(screen.getByRole('button', { name: '清理未固定的缓存' }));
  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/将移出 1 本未固定的书籍/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: '确认清理' }));

  expect(await screen.findByText('已清理 1 本未固定的缓存')).toBeInTheDocument();
  await waitFor(() => expect(screen.queryByText('三体')).toBeNull());
  expect(screen.getByText('深入理解计算机系统')).toBeInTheDocument();
  expect(await session.db.offlineBooks.get([USER, BOOK_THREE_BODY])).toBeUndefined();
  expect(await session.db.offlineBooks.get([USER, BOOK_CSAPP])).toBeDefined();
});

it('pins and removes a cached book', async () => {
  const session = createSession();
  await session.cache.cacheFromUrl(
    USER,
    BOOK_THREE_BODY,
    'book',
    'https://files.test/small.epub',
  );

  const { engine } = createEngine();
  renderSettings(engine, session);

  const pinSwitch = await screen.findByRole('switch', { name: '固定《三体》' });
  expect(pinSwitch).toHaveAttribute('aria-checked', 'false');

  await userEvent.click(pinSwitch);
  expect(await screen.findByText('《三体》已固定，不会被自动清理')).toBeInTheDocument();
  await waitFor(async () => {
    expect((await session.db.offlineBooks.get([USER, BOOK_THREE_BODY]))?.pinned).toBe(true);
  });

  await userEvent.click(screen.getByRole('button', { name: '将《三体》移出本机' }));
  expect(await screen.findByText('《三体》已移出本机')).toBeInTheDocument();
  await waitFor(async () => {
    expect(await session.db.offlineBooks.get([USER, BOOK_THREE_BODY])).toBeUndefined();
  });
});

it('uses the on-device shelf snapshot when the book API is unavailable', async () => {
  const session = createSession();
  await session.cache.cacheFromUrl(
    USER,
    BOOK_THREE_BODY,
    'book',
    'https://files.test/small.epub',
  );
  await session.db.shelf.put({
    id: BOOK_THREE_BODY,
    userId: USER,
    title: '三体（本机快照）',
    author: '刘慈欣',
    format: 'epub',
    coverUrl: null,
    updatedAt: '2026-10-01T00:00:00.000Z',
    reflowAvailable: true,
  });
  server.use(
    http.get('/api/books/:id', () =>
      HttpResponse.json(
        { error: { code: 'INTERNAL', message: 'offline' } },
        { status: 500 },
      ),
    ),
  );

  const { engine } = createEngine();
  renderSettings(engine, session);

  expect(await screen.findByText('三体（本机快照）')).toBeInTheDocument();
  // The snapshot also carries format and reflow availability.
  expect(screen.getByText('EPUB · 2 KB')).toBeInTheDocument();
  expect(screen.getByText('可重排')).toBeInTheDocument();
  expect(screen.queryByText('未知图书')).toBeNull();
});

it('renames and revokes a device', async () => {
  const devices: DeviceItem[] = [
    {
      id: 'device-current',
      name: '书房电脑',
      platform: 'web',
      lastSeenAt: '2026-10-18T09:30:00.000Z',
      createdAt: '2026-09-01T08:00:00.000Z',
      current: true,
    },
    {
      id: 'device-ipad',
      name: 'iPad',
      platform: 'ios',
      lastSeenAt: null,
      createdAt: '2026-09-20T08:00:00.000Z',
      current: false,
    },
  ];

  server.use(
    http.get('/api/devices', () => HttpResponse.json({ items: devices })),
    http.patch('/api/devices/:id', async ({ params, request }) => {
      const body = (await request.json()) as { name: string | null };
      const found = devices.find((device) => device.id === params.id);
      if (!found) {
        return HttpResponse.json(
          { error: { code: 'NOT_FOUND', message: 'Device not found' } },
          { status: 404 },
        );
      }
      found.name = body.name;
      return HttpResponse.json({ device: { ...found } });
    }),
    http.delete('/api/devices/:id', ({ params }) => {
      const index = devices.findIndex((device) => device.id === params.id);
      if (index !== -1) devices.splice(index, 1);
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const { engine } = createEngine();
  renderSettings(engine);

  expect(await screen.findByText('书房电脑')).toBeInTheDocument();
  expect(screen.getByText('iPad')).toBeInTheDocument();
  expect(screen.getByText('当前设备')).toBeInTheDocument();
  expect(screen.getByText(/网页 · 最近活跃：/)).toBeInTheDocument();
  expect(screen.getByText(/iOS · 最近活跃：暂无记录/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '重命名 iPad' }));
  const renameDialog = await screen.findByRole('dialog');
  const nameInput = within(renameDialog).getByLabelText('设备名称');
  await userEvent.clear(nameInput);
  await userEvent.type(nameInput, '通勤 iPad');
  await userEvent.click(within(renameDialog).getByRole('button', { name: '保存' }));

  expect(await screen.findByText('通勤 iPad')).toBeInTheDocument();
  expect(devices.find((device) => device.id === 'device-ipad')?.name).toBe('通勤 iPad');

  await userEvent.click(screen.getByRole('button', { name: '撤销 通勤 iPad' }));
  const revokeDialog = await screen.findByRole('dialog');
  await userEvent.click(within(revokeDialog).getByRole('button', { name: '确认撤销' }));

  await waitFor(() => expect(screen.queryByText('通勤 iPad')).toBeNull());
  expect(screen.getByText('书房电脑')).toBeInTheDocument();
  expect(devices.map((device) => device.id)).toEqual(['device-current']);
});

it('logs out after revoking the current device', async () => {
  const devices: DeviceItem[] = [
    {
      id: 'device-current',
      name: '书房电脑',
      platform: 'web',
      lastSeenAt: '2026-10-18T09:30:00.000Z',
      createdAt: '2026-09-01T08:00:00.000Z',
      current: true,
    },
  ];
  let logoutCalled = false;

  server.use(
    http.get('/api/devices', () => HttpResponse.json({ items: devices })),
    http.delete('/api/devices/:id', () => {
      devices.splice(0, devices.length);
      return new HttpResponse(null, { status: 204 });
    }),
    http.post('/api/auth/logout', () => {
      logoutCalled = true;
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const { engine } = createEngine();
  renderSettings(engine);

  expect(await screen.findByText('书房电脑')).toBeInTheDocument();
  await userEvent.click(screen.getByRole('button', { name: '撤销 书房电脑' }));

  const dialog = await screen.findByRole('dialog');
  expect(within(dialog).getByText(/这是当前设备/)).toBeInTheDocument();
  await userEvent.click(within(dialog).getByRole('button', { name: '确认撤销' }));

  expect(await screen.findByRole('heading', { name: '登录书房' })).toBeInTheDocument();
  expect(logoutCalled).toBe(true);
  expect(localStorage.getItem('bookr.tokens')).toBeNull();
});
