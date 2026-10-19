import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it, vi } from 'vitest';
import { http, HttpResponse } from 'msw';
import { setTokens } from '../../../api/client';
import { reader, renderWithProviders, server } from '../../../../test/setup';
import { TimezoneSettingsSection } from '../SettingsPage';

beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
});

function renderSettings() {
  return renderWithProviders(<TimezoneSettingsSection />);
}

it('shows the current statistics timezone', async () => {
  renderSettings();

  const select = await screen.findByLabelText('统计时区');
  expect(select).toHaveValue('Asia/Shanghai');
  expect(screen.getByText('统计按此时区划分自然日，跨时区旅行不会重复计时。')).toBeInTheDocument();
});

it('saves a new timezone and confirms it', async () => {
  let timezone = 'Asia/Shanghai';
  let patchBody: unknown = null;
  server.use(
    http.get('/api/auth/me', () => HttpResponse.json({ ...reader, timezone })),
    http.patch('/api/auth/me', async ({ request }) => {
      patchBody = await request.json();
      const body = patchBody as { timezone: string };
      timezone = body.timezone;
      return HttpResponse.json({ timezone });
    }),
  );

  renderSettings();
  const select = await screen.findByLabelText('统计时区');
  await userEvent.selectOptions(select, 'America/New_York');

  await waitFor(() => expect(patchBody).toEqual({ timezone: 'America/New_York' }));
  expect(await screen.findByText('已保存')).toBeInTheDocument();
  await waitFor(() => expect(select).toHaveValue('America/New_York'));
});

it('keeps the attempted value and explains a failed save', async () => {
  server.use(
    http.patch('/api/auth/me', () =>
      HttpResponse.json(
        { error: { code: 'VALIDATION_FAILED', message: 'invalid timezone' } },
        { status: 400 },
      ),
    ),
  );

  renderSettings();
  const select = await screen.findByLabelText('统计时区');
  await userEvent.selectOptions(select, 'America/New_York');

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('时区保存失败，请重试');
  expect(select).toHaveValue('America/New_York');
  expect(within(alert.closest('section') as HTMLElement).getByRole('button', { name: '重试' })).toBeVisible();
});
