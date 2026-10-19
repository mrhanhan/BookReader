import { screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { http, HttpResponse } from 'msw';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { beforeEach, expect, it } from 'vitest';
import { setTokens } from '../../../api/client';
import { routes } from '../../../app/router';
import { renderWithProviders, server, signInAsAdmin } from '../../../../test/setup';

// The category screen lives behind RequireAuth, so seed a stored session first.
beforeEach(() => {
  setTokens({
    accessToken: 'test-access-token',
    refreshToken: 'test-refresh-token-which-is-long-enough',
    expiresIn: 900,
  });
});

/** Renders the administration screen for the shared categories. */
function renderCategoriesPage() {
  const router = createMemoryRouter(routes, { initialEntries: ['/admin/categories'] });
  renderWithProviders(<RouterProvider router={router} />);
  return router;
}

it('lists the shared categories with their colours', async () => {
  signInAsAdmin();
  renderCategoriesPage();

  expect(await screen.findByText('计算机')).toBeInTheDocument();
  expect(screen.getByText('文学')).toBeInTheDocument();
  expect(screen.getByText('#8C5A3B')).toBeInTheDocument();
  // Administrators reach the section from the shared tab bar.
  expect(screen.getByRole('link', { name: '分类' })).toBeInTheDocument();
  // The first row cannot move up and the last cannot move down.
  expect(screen.getByRole('button', { name: '上移 计算机' })).toBeDisabled();
  expect(screen.getByRole('button', { name: '下移 文学' })).toBeDisabled();
});

it('renames a category through the row editor', async () => {
  signInAsAdmin();
  const patches: Array<{ id: string; patch: Record<string, unknown> }> = [];
  server.use(
    http.patch('/api/categories/:id', async ({ params, request }) => {
      const patch = (await request.json()) as Record<string, unknown>;
      patches.push({ id: String(params.id), patch });
      return HttpResponse.json({
        id: params.id,
        name: patch.name ?? '计算机',
        color: patch.color ?? '#8C5A3B',
      });
    }),
  );
  renderCategoriesPage();

  await userEvent.click(await screen.findByRole('button', { name: '编辑 计算机' }));
  const nameInput = screen.getByLabelText('重命名 计算机');
  await userEvent.clear(nameInput);
  await userEvent.type(nameInput, '计算机科学');
  await userEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(patches).toHaveLength(1));
  expect(patches[0]).toEqual({ id: 'cat-computer', patch: { name: '计算机科学' } });
});

it('moves a category up by sending the whole order', async () => {
  signInAsAdmin();
  const bodies: unknown[] = [];
  server.use(
    http.put('/api/categories/order', async ({ request }) => {
      bodies.push(await request.json());
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderCategoriesPage();

  await userEvent.click(await screen.findByRole('button', { name: '上移 文学' }));

  await waitFor(() => expect(bodies).toHaveLength(1));
  expect(bodies[0]).toEqual({ ids: ['cat-literature', 'cat-computer'] });
});

it('asks for confirmation before deleting a category', async () => {
  signInAsAdmin();
  const deleted: string[] = [];
  server.use(
    http.delete('/api/categories/:id', ({ params }) => {
      deleted.push(String(params.id));
      return new HttpResponse(null, { status: 204 });
    }),
  );
  renderCategoriesPage();

  await userEvent.click(await screen.findByRole('button', { name: '删除 文学' }));

  const dialog = await screen.findByRole('dialog');
  expect(dialog).toHaveTextContent('只会解除书籍与它的关联，不会删除任何图书');
  // Nothing is deleted until the administrator confirms.
  expect(deleted).toEqual([]);

  await userEvent.click(screen.getByRole('button', { name: '确认删除' }));
  await waitFor(() => expect(deleted).toEqual(['cat-literature']));
});

it('creates a category from the administration screen', async () => {
  signInAsAdmin();
  renderCategoriesPage();

  const nameInput = await screen.findByLabelText('分类名称');
  await userEvent.type(nameInput, '历史');
  await userEvent.click(screen.getByRole('button', { name: '创建分类' }));

  expect(await screen.findByText('历史')).toBeInTheDocument();
  expect(nameInput).toHaveValue('');
});

it('redirects members away from the category administration', async () => {
  server.use(
    http.get('/api/auth/me', () =>
      HttpResponse.json({ id: 'u2', username: 'bob', displayName: 'Bob', role: 'member' }),
    ),
  );
  const router = renderCategoriesPage();

  await waitFor(() => expect(router.state.location.pathname).toBe('/'));
  expect(screen.queryByRole('heading', { name: '分类列表' })).toBeNull();
  expect(screen.queryByRole('link', { name: '分类' })).toBeNull();
});
