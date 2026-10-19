import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { AuditLogEntryDto } from '@bookr/shared';
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

function entry(
  index: number,
  overrides: Partial<AuditLogEntryDto> = {},
): AuditLogEntryDto {
  return {
    id: `audit-${index}`,
    userId: 'user-admin',
    displayName: '掌灯人',
    action: 'auth.login',
    target: null,
    metadata: null,
    createdAt: new Date(Date.now() - index * 60_000).toISOString(),
    ...overrides,
  };
}

const longMetadata = {
  title: '三体',
  reason: '管理员清理重复上传的版本，并保留最新的精校版文件',
  size: 3_145_728,
  note: 'x'.repeat(200),
};

const pageOne = Array.from({ length: 20 }, (_, index) => entry(index));
const pageTwo: AuditLogEntryDto[] = [
  entry(20, { action: 'book.delete', target: 'book-three-body', metadata: longMetadata }),
  entry(21, { action: 'custom.unknown', target: 'mystery' }),
  entry(22, { action: 'admin.settings.update', target: 'system_settings' }),
  entry(23, { action: 'ai.config.update', target: 'ai_config' }),
  entry(24, { userId: null, displayName: null, action: 'auth.register', target: 'user-new' }),
];

function renderAudit() {
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/audit'] });
  return renderWithProviders(<RouterProvider router={router} />);
}

it('pages through audit entries with readable labels and raw fallbacks', async () => {
  const requestedPages: string[] = [];
  server.use(
    http.get('/api/admin/audit', ({ request }) => {
      const params = new URL(request.url).searchParams;
      const page = Number(params.get('page') ?? '1');
      requestedPages.push(String(page));
      return HttpResponse.json({
        items: page === 2 ? pageTwo : pageOne,
        page,
        pageSize: 20,
        total: 25,
      });
    }),
  );

  renderAudit();

  // Twenty rows plus the header.
  expect(await screen.findAllByText('登录')).toHaveLength(20);
  expect(screen.getAllByRole('row')).toHaveLength(21);
  expect(screen.getByText('第 1 / 2 页')).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '下一页' }));

  expect(await screen.findByText('第 2 / 2 页')).toBeInTheDocument();
  await waitFor(() => expect(requestedPages).toContain('2'));

  expect(screen.getByText('删除图书')).toBeInTheDocument();
  expect(screen.getByText('修改系统设置')).toBeInTheDocument();
  expect(screen.getByText('更新 AI 配置')).toBeInTheDocument();
  // Unknown actions are shown verbatim rather than swallowed.
  expect(screen.getByText('custom.unknown')).toBeInTheDocument();
  // A member who no longer has a display name reads as the system actor.
  expect(screen.getByText('系统')).toBeInTheDocument();
});

it('truncates metadata but keeps the full JSON in the title attribute', async () => {
  server.use(
    http.get('/api/admin/audit', () =>
      HttpResponse.json({
        items: pageTwo,
        page: 1,
        pageSize: 20,
        total: 25,
      }),
    ),
  );

  renderAudit();

  const full = JSON.stringify(longMetadata);
  const truncated = await screen.findByTitle(full);
  expect(truncated.textContent?.length).toBeLessThanOrEqual(121);
  expect(truncated.textContent?.endsWith('…')).toBe(true);
});
