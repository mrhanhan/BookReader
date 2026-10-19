import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { backupStatus, renderWithProviders, server, signInAsAdmin } from '../../../../test/setup';

beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
  signInAsAdmin();
});

function renderBackups() {
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/backups'] });
  return renderWithProviders(<RouterProvider router={router} />);
}

it('shows the last successful backup and the report ledger', async () => {
  renderBackups();

  expect(await screen.findByText('最近成功备份')).toBeInTheDocument();
  expect(screen.getByText('备份机最近上报')).toBeInTheDocument();
  expect(screen.getByText('磁盘可用')).toBeInTheDocument();
  expect(screen.getByText('服务器导出完成')).toBeInTheDocument();
  expect(screen.getByText('备份机拉取完成')).toBeInTheDocument();
  expect(screen.getByText('服务器导出')).toBeInTheDocument();
  expect(screen.getByText('备份机')).toBeInTheDocument();
  expect(screen.getByText('2.5 GB')).toBeInTheDocument();
});

it('warns when the server backup is stale', async () => {
  server.use(
    http.get('/api/admin/backup', () => HttpResponse.json(backupStatus({ backupStale: true }))),
  );

  renderBackups();

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('备份已超过 24 小时未成功');
});

it('tells an administrator where to start when no backup has ever run', async () => {
  server.use(
    http.get('/api/admin/backup', () => HttpResponse.json(backupStatus({ reports: [] }))),
  );

  renderBackups();

  expect(
    await screen.findByText('尚无备份记录，请先运行服务器备份脚本'),
  ).toBeInTheDocument();
});

it('refetches the status when the refresh button is pressed', async () => {
  let calls = 0;
  server.use(
    http.get('/api/admin/backup', () => {
      calls += 1;
      return HttpResponse.json(backupStatus());
    }),
  );

  renderBackups();
  await screen.findByText('最近成功备份');
  await waitFor(() => expect(calls).toBe(1));

  await userEvent.click(screen.getByRole('button', { name: '刷新' }));

  await waitFor(() => expect(calls).toBe(2));
});
