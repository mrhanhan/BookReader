import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { LIBRARY_QUOTA_BYTES, MEMBER_UPLOAD_QUOTA_BYTES } from '@bookr/shared';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';

// The admin page lives behind RequireAuth, so seed a stored session first.
beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
});

/** Overrides `/api/auth/me` with an administrator for the duration of one test. */
function signInAsAdmin() {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({
        id: 'user-admin',
        username: 'admin',
        displayName: '掌灯人',
        role: 'admin',
        timezone: 'Asia/Shanghai',
        aiEnabled: false,
        uploadUsedBytes: 0,
        uploadQuotaBytes: 20 * 1024 * 1024 * 1024,
        libraryUsedBytes: 0,
        libraryQuotaBytes: 80 * 1024 * 1024 * 1024,
      }),
    ),
  );
}

it('lists members and creates an invite code for admins', async () => {
  signInAsAdmin();
  server.use(
    http.get('/api/admin/members', () =>
      HttpResponse.json({
        items: [
          {
            id: 'u1',
            username: 'alice',
            displayName: 'Alice',
            role: 'member',
            isActive: true,
            uploadQuotaBytes: 1000,
            usedBytes: 300,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    ),
  );
  server.use(
    http.post('/api/admin/invites', () =>
      HttpResponse.json(
        { code: 'ABCD234567', expiresAt: new Date().toISOString() },
        { status: 201 },
      ),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText('Alice')).toBeInTheDocument();
  // The admin-only nav link appears for administrators.
  expect(screen.getByRole('link', { name: '管理' })).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '生成邀请码' }));
  expect(await screen.findByText('ABCD234567')).toBeInTheDocument();
});

it('redirects members away from the admin page', async () => {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ id: 'u2', username: 'bob', displayName: 'Bob', role: 'member' }),
    ),
  );
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);

  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  // Members never see the administration entry point.
  expect(screen.queryByRole('link', { name: '管理' })).toBeNull();
});

it('tells members to contact an admin when the shared shelf nears capacity', async () => {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({
        id: 'u2',
        username: 'bob',
        displayName: 'Bob',
        role: 'member',
        timezone: 'Asia/Shanghai',
        aiEnabled: false,
        uploadUsedBytes: 0,
        uploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
        libraryUsedBytes: LIBRARY_QUOTA_BYTES - 1,
        libraryQuotaBytes: LIBRARY_QUOTA_BYTES,
      }),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText('共享书库空间即将用尽，请联系管理员')).toBeInTheDocument();
  // Members must not be sent to a route that would bounce them home.
  expect(screen.queryByRole('link', { name: '查看存储用量' })).toBeNull();
});

it('does not offer the current administrator a self-deactivation toggle', async () => {
  signInAsAdmin();
  server.use(
    http.get('/api/admin/members', () =>
      HttpResponse.json({
        items: [
          {
            id: 'user-admin',
            username: 'admin',
            displayName: '掌灯人',
            role: 'admin',
            isActive: true,
            uploadQuotaBytes: 1000,
            usedBytes: 0,
            createdAt: new Date().toISOString(),
          },
          {
            id: 'u1',
            username: 'alice',
            displayName: 'Alice',
            role: 'member',
            isActive: true,
            uploadQuotaBytes: 1000,
            usedBytes: 300,
            createdAt: new Date().toISOString(),
          },
        ],
      }),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText('当前账号')).toBeInTheDocument();
  // The signed-in admin cannot lock themselves out of the shelf.
  expect(screen.queryByRole('switch', { name: '掌灯人 账号状态' })).toBeNull();
  // Other members keep their toggle, so the rule is not "hide every switch".
  expect(screen.getByRole('switch', { name: 'Alice 账号状态' })).toBeInTheDocument();
});

it('saves AI access and token limits from the member editor, leaving blank limits alone', async () => {
  signInAsAdmin();
  const patches: Array<Record<string, unknown>> = [];
  server.use(
    http.patch('/api/admin/members/:id', async ({ params, request }) => {
      const patch = (await request.json()) as Record<string, unknown>;
      patches.push(patch);
      return HttpResponse.json({
        id: params.id,
        username: 'linzhou',
        displayName: '林舟',
        role: 'member',
        isActive: true,
        uploadQuotaBytes: 10 * 1024 * 1024 * 1024,
        aiEnabled: true,
        aiDailyTokenLimit: 50_000,
        aiMonthlyTokenLimit: 200_000,
        usedBytes: 3 * 1024 * 1024,
        createdAt: new Date().toISOString(),
      });
    }),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/admin/members'] });
  renderWithProviders(<RouterProvider router={router} />);

  await userEvent.click(await screen.findByRole('button', { name: '编辑 林舟' }));
  await userEvent.click(screen.getByRole('checkbox', { name: '启用 AI 伴读' }));
  await userEvent.type(screen.getByLabelText('每日 token 上限'), '50000');
  await userEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toMatchObject({ aiEnabled: true, aiDailyTokenLimit: 50_000 });
  // A blank monthly field must not clobber the stored value.
  expect(patches[0]).not.toHaveProperty('aiMonthlyTokenLimit');

  await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  await userEvent.click(screen.getByRole('button', { name: '编辑 林舟' }));
  await userEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(patches).toHaveLength(2));
  expect(patches[1]).not.toHaveProperty('aiDailyTokenLimit');
  expect(patches[1]).not.toHaveProperty('aiMonthlyTokenLimit');
});
