import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server, signInAsAdmin } from '../../../../test/setup';

beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
  signInAsAdmin();
});

function renderSettings() {
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/settings'] });
  return renderWithProviders(<RouterProvider router={router} />);
}

it('shows the registration switch, consequence copy and default timezone', async () => {
  renderSettings();

  expect(await screen.findByRole('checkbox', { name: '允许新成员注册' })).toBeChecked();
  expect(screen.getByLabelText('默认时区')).toHaveValue('Asia/Shanghai');
  expect(screen.getByText('关闭后，即使持有邀请码也无法注册新成员')).toBeInTheDocument();
  // The settings tab is the current administration page.
  const adminNav = screen.getByRole('navigation', { name: '管理导航' });
  expect(within(adminNav).getByRole('link', { name: '设置' })).toHaveAttribute(
    'aria-current',
    'page',
  );
});

it('patches registration and default timezone together', async () => {
  const bodies: unknown[] = [];
  server.use(
    http.patch('/api/admin/settings', async ({ request }) => {
      bodies.push(await request.json());
      return HttpResponse.json({
        registrationEnabled: false,
        defaultTimezone: 'America/New_York',
        updatedAt: new Date().toISOString(),
      });
    }),
  );

  renderSettings();

  await userEvent.click(await screen.findByRole('checkbox', { name: '允许新成员注册' }));
  await userEvent.selectOptions(screen.getByLabelText('默认时区'), 'America/New_York');
  await userEvent.click(screen.getByRole('button', { name: '保存设置' }));

  expect(await screen.findByText('设置已保存')).toBeInTheDocument();
  expect(bodies).toEqual([
    { registrationEnabled: false, defaultTimezone: 'America/New_York' },
  ]);
});

it('sends the AI key only when one is typed and keeps a blank key on the second save', async () => {
  const puts: Array<Record<string, unknown>> = [];
  server.use(
    http.put('/api/admin/ai', async ({ request }) => {
      const body = (await request.json()) as Record<string, unknown>;
      puts.push(body);
      return HttpResponse.json({
        configured: true,
        fakeProvider: false,
        baseUrl: (body.baseUrl as string | undefined) ?? 'https://api.example.com/v1',
        chatModel: null,
        reasonerModel: null,
        hasApiKey: true,
        updatedAt: new Date().toISOString(),
      });
    }),
  );

  renderSettings();

  await userEvent.type(await screen.findByLabelText('Base URL'), 'https://api.example.com/v1');
  await userEvent.type(screen.getByLabelText('API Key'), 'sk-test-12345678');
  await userEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }));

  await waitFor(() => expect(puts).toHaveLength(1));
  expect(puts[0]).toMatchObject({
    baseUrl: 'https://api.example.com/v1',
    apiKey: 'sk-test-12345678',
  });

  // The key is write-only: the input clears after saving and the next request
  // must leave the stored key untouched.
  await waitFor(() => expect(screen.getByLabelText('API Key')).toHaveValue(''));
  await userEvent.click(screen.getByRole('button', { name: '保存 AI 配置' }));

  await waitFor(() => expect(puts).toHaveLength(2));
  expect(puts[1]).not.toHaveProperty('apiKey');
});
