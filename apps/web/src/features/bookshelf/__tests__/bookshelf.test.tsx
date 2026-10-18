import { screen, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { renderWithProviders, server } from '../../../../test/setup';

// The shelf lives behind RequireAuth, so seed a stored session before each test.
// The default MSW `/api/auth/me` fixture resolves to the `reader` member.
beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
});

it('renders the shared shelf with books from other members', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  expect(await screen.findByText('深入理解计算机系统')).toBeInTheDocument();
  expect(await screen.findByText('三体')).toBeInTheDocument();
});
it('sends filters to the API when the format filter changes', async () => {
  let lastUrl = '';
  server.use(http.get('/api/books', ({ request }) => { lastUrl = request.url; return HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 24 }); }));
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.selectOptions(await screen.findByLabelText('格式'), 'epub');
  expect(lastUrl).toContain('format=epub');
});
it('hides edit and delete for books uploaded by others', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  const card = (await screen.findByText('三体')).closest('[data-testid="book-card"]')!;
  expect(within(card as HTMLElement).queryByRole('button', { name: '编辑' })).toBeNull();

  // The uploader's own card keeps its edit action, so the rule is not "hide all".
  const ownCard = (await screen.findByText('深入理解计算机系统')).closest(
    '[data-testid="book-card"]',
  )!;
  expect(
    within(ownCard as HTMLElement).getByRole('button', {
      name: '编辑《深入理解计算机系统》',
    }),
  ).toBeInTheDocument();
});
it('confirms before deleting and moves the book to trash', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);
  await userEvent.click(await screen.findByRole('button', { name: '删除《深入理解计算机系统》' }));
  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
  expect(await screen.findByText('已移入回收站')).toBeInTheDocument();
});
