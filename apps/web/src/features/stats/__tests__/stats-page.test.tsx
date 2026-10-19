import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { ReadingStatsDto } from '@bookr/shared';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { readingStats, renderWithProviders, server } from '../../../../test/setup';
import { formatChartDuration, formatDuration } from '../format';

// The stats page lives behind RequireAuth, so seed a stored session first.
// The default MSW `/api/auth/me` fixture resolves to the `reader` member.
beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  // The offline test installs an own property over jsdom's getter; restore it
  // so later suites see the default online state.
  Reflect.deleteProperty(navigator, 'onLine');
  window.dispatchEvent(new Event('online'));
});

function renderStats() {
  const router = createMemoryRouter(routes, { initialEntries: ['/stats'] });
  return renderWithProviders(<RouterProvider router={router} />);
}

/** The same 30-day window as the default fixture, but every day is empty. */
function zeroStats(): ReadingStatsDto {
  const stats = readingStats();
  return {
    ...stats,
    streakDays: 0,
    effectiveDays: 0,
    todaySeconds: 0,
    weekSeconds: 0,
    monthSeconds: 0,
    finishedBooks: 0,
    topBook: null,
    daily: stats.daily.map((day) => ({ ...day, activeSeconds: 0, qualified: false })),
  };
}

it('renders the streak, totals, timezone and top book', async () => {
  renderStats();

  expect(await screen.findByRole('heading', { name: '统计' })).toBeInTheDocument();
  expect(screen.getByText('你读过的每一段安静时光')).toBeInTheDocument();

  const streak = (await screen.findByText('天连续阅读')).closest('p');
  expect(streak).toHaveTextContent('3');
  expect(
    screen.getByText(/单日有效阅读满 10 分钟计为一天 · 按 Asia\/Shanghai 时区统计/),
  ).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '修改时区' })).toHaveAttribute('href', '/settings');

  expect(screen.getByText('今日')).toBeInTheDocument();
  expect(screen.getByText('12 分钟')).toBeInTheDocument();
  expect(screen.getByText('本周')).toBeInTheDocument();
  expect(screen.getByText('40 分钟')).toBeInTheDocument();
  expect(screen.getByText('本月')).toBeInTheDocument();
  expect(screen.getByText('1 小时 30 分钟')).toBeInTheDocument();
  expect(screen.getByText('累计有效')).toBeInTheDocument();
  expect(screen.getByText('9 天')).toBeInTheDocument();
  expect(screen.getByText('读完的书')).toBeInTheDocument();
  expect(screen.getByText('2 本')).toBeInTheDocument();

  expect(screen.getByText('深入理解计算机系统')).toBeInTheDocument();
  expect(screen.getByText('3 小时 30 分钟')).toBeInTheDocument();
});

it('draws 30 accessible daily bars and marks today', async () => {
  renderStats();

  const list = await screen.findByRole('list', { name: '每日阅读时长' });
  const items = within(list).getAllByRole('listitem');
  expect(items).toHaveLength(30);
  expect(screen.getByText('最近 30 天')).toBeInTheDocument();

  for (const item of items) {
    expect(item).toHaveAccessibleName();
  }

  const todayItem = items.find((item) =>
    (item.getAttribute('aria-label') ?? '').includes('今天'),
  );
  expect(todayItem).toBeDefined();
  expect(todayItem).toHaveAttribute('aria-label', expect.stringContaining('12 分钟'));
});

it('shows the first-day prompt while keeping all 30 bars when the data is empty', async () => {
  server.use(http.get('/api/stats', () => HttpResponse.json(zeroStats())));

  renderStats();

  expect(
    await screen.findByText('打开一本书，读满 10 分钟就会记下第一天。'),
  ).toBeInTheDocument();
  const list = screen.getByRole('list', { name: '每日阅读时长' });
  expect(within(list).getAllByRole('listitem')).toHaveLength(30);
  expect(screen.getByText('还没有最常读的书')).toBeInTheDocument();
});

it('shows an alert with a working retry button when the request fails', async () => {
  let calls = 0;
  server.use(
    http.get('/api/stats', () => {
      calls += 1;
      if (calls === 1) {
        return HttpResponse.json(
          { error: { code: 'INTERNAL', message: 'boom' } },
          { status: 500 },
        );
      }
      return HttpResponse.json(readingStats());
    }),
  );

  renderStats();

  const alert = await screen.findByRole('alert');
  expect(alert).toHaveTextContent('服务器出了点问题，请稍后重试');

  await userEvent.click(within(alert).getByRole('button', { name: '重试' }));

  expect(await screen.findByText('12 分钟')).toBeInTheDocument();
  await waitFor(() => expect(calls).toBe(2));
});

it('keeps the cached stats and explains them while offline', async () => {
  renderStats();
  await screen.findByText('12 分钟');

  act(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });

  expect(
    await screen.findByText('离线：显示上次同步的统计'),
  ).toBeInTheDocument();
  expect(screen.getByText('12 分钟')).toBeInTheDocument();
});

describe('formatDuration', () => {
  it('floors to whole minutes and spells out hours', () => {
    expect(formatDuration(0)).toBe('0 分钟');
    expect(formatDuration(59)).toBe('不足 1 分钟');
    expect(formatDuration(60)).toBe('1 分钟');
    expect(formatDuration(3599)).toBe('59 分钟');
    expect(formatDuration(3600)).toBe('1 小时');
    expect(formatDuration(3660)).toBe('1 小时 1 分钟');
    expect(formatDuration(5400)).toBe('1 小时 30 分钟');
  });
});

describe('formatChartDuration', () => {
  it('keeps zero explicit and rounds sub-minute values down to the prompt', () => {
    expect(formatChartDuration(0)).toBe('0 分钟');
    expect(formatChartDuration(45)).toBe('不足 1 分钟');
    expect(formatChartDuration(600)).toBe('10 分钟');
  });
});
