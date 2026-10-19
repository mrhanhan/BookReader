import { screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { beforeEach, expect, it } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import type { BookDto } from '@bookr/shared';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { book, renderWithProviders, server } from '../../../../test/setup';

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
it('shows the remaining retention days from the deletion time', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/trash'] });
  renderWithProviders(<RouterProvider router={router} />);
  expect(await screen.findByText('设计数据密集型应用')).toBeInTheDocument();
  expect(screen.getByText('剩余 20 天')).toBeInTheDocument();
});
it('opens the upload dialog from the empty shelf state', async () => {
  server.use(
    http.get('/api/books', () =>
      HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 24 }),
    ),
  );
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByRole('button', { name: '上传图书' })).toBeInTheDocument();
  await userEvent.click(await screen.findByRole('button', { name: '上传第一本书' }));

  expect(await screen.findByText('把图书文件拖到这里')).toBeInTheDocument();
  expect(screen.getByLabelText('选择文件')).toHaveAttribute(
    'accept',
    '.pdf,.epub,.mobi,.azw3',
  );
});

it('requests the next page and renders its books', async () => {
  const pageBook = (page: number): BookDto => ({
    id: `page-book-${page}`,
    title: page === 1 ? '第一页的书' : '第二页的书',
    author: '作者',
    description: null,
    format: 'epub',
    size: 1024,
    coverUrl: null,
    status: 'unread',
    progressPercent: 0,
    categories: [],
    uploadedBy: { id: 'user-other', displayName: '林舟' },
    conversionStatus: 'none',
    conversionError: null,
    reflowAvailable: false,
    reflowSchemaVersion: null,
    reflowPageCount: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  });

  let lastUrl = '';
  server.use(
    http.get('/api/books', ({ request }) => {
      lastUrl = request.url;
      const page = Number(new URL(request.url).searchParams.get('page') ?? 1);
      return HttpResponse.json({ items: [pageBook(page)], total: 30, page, pageSize: 24 });
    }),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  expect(await screen.findByText('第一页的书')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '加载更多' })).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '加载更多' }));

  expect(await screen.findByText('第二页的书')).toBeInTheDocument();
  expect(screen.getByText('第一页的书')).toBeInTheDocument();
  expect(lastUrl).toContain('page=2');
  expect(await screen.findByText('书架已到底')).toBeInTheDocument();

  // Changing a filter restarts the scroll list at the first page.
  await userEvent.selectOptions(screen.getByLabelText('格式'), 'epub');
  expect(await screen.findByText('第一页的书')).toBeInTheDocument();
  expect(screen.queryByText('第二页的书')).not.toBeInTheDocument();
  expect(lastUrl).toContain('page=1');
  expect(lastUrl).toContain('format=epub');
});

it('shows a failed conversion and lets the uploader retry it', async () => {
  const failed: BookDto = {
    id: 'book-failed-conversion',
    title: '转换失败的书',
    author: null,
    description: null,
    format: 'mobi',
    size: 2048,
    coverUrl: null,
    status: 'unread',
    progressPercent: 0,
    categories: [],
    uploadedBy: { id: 'user-reader', displayName: '读者' },
    conversionStatus: 'failed',
    conversionError: 'Conversion process exited with code 1',
    reflowAvailable: false,
    reflowSchemaVersion: null,
    reflowPageCount: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    deletedAt: null,
  };

  server.use(
    http.get('/api/books', () =>
      HttpResponse.json({ items: [failed], total: 1, page: 1, pageSize: 24 }),
    ),
    http.post('/api/books/:id/convert', () =>
      HttpResponse.json({ queued: true }, { status: 202 }),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  const card = (await screen.findByText('转换失败的书')).closest(
    '[data-testid="book-card"]',
  ) as HTMLElement;
  expect(within(card).getByText('转换失败')).toBeInTheDocument();
  expect(within(card).getByText('Conversion process exited with code 1')).toBeInTheDocument();

  await userEvent.click(
    within(card).getByRole('button', { name: '重试转换《转换失败的书》' }),
  );
  expect(await screen.findByText('已重新开始转换《转换失败的书》')).toBeInTheDocument();
});

it('marks PDF books that have a reflow pack', async () => {
  const reflowable = book({
    id: 'book-reflowable',
    title: '可重排的书',
    format: 'pdf',
    reflowAvailable: true,
    reflowSchemaVersion: 1,
    reflowPageCount: 300,
  });
  const plain = book({ id: 'book-plain', title: '普通 PDF', format: 'pdf' });
  server.use(
    http.get('/api/books', () =>
      HttpResponse.json({ items: [reflowable, plain], total: 2, page: 1, pageSize: 24 }),
    ),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  const withPack = (await screen.findByText('可重排的书')).closest(
    '[data-testid="book-card"]',
  ) as HTMLElement;
  expect(within(withPack).getByText('可重排')).toBeInTheDocument();

  const withoutPack = (await screen.findByText('普通 PDF')).closest(
    '[data-testid="book-card"]',
  ) as HTMLElement;
  expect(within(withoutPack).queryByText('可重排')).toBeNull();
});

it('shows the fresh reflow state when the edit dialog is reopened', async () => {
  const shelf: BookDto[] = [
    book({
      id: 'book-reflow-remove',
      title: '带重排包的 PDF',
      format: 'pdf',
      uploadedBy: { id: 'user-reader', displayName: '读者' },
      reflowAvailable: true,
      reflowSchemaVersion: 1,
      reflowPageCount: 300,
    }),
  ];
  server.use(
    http.get('/api/books', () =>
      HttpResponse.json({ items: [...shelf], total: 1, page: 1, pageSize: 24 }),
    ),
    http.delete('/api/books/:id/reflow', () => {
      shelf[0] = {
        ...shelf[0]!,
        reflowAvailable: false,
        reflowSchemaVersion: null,
        reflowPageCount: null,
      };
      return new HttpResponse(null, { status: 204 });
    }),
  );

  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  await userEvent.click(
    await screen.findByRole('button', { name: '编辑《带重排包的 PDF》' }),
  );
  expect(await screen.findByText(/300 页/)).toBeInTheDocument();

  await userEvent.click(screen.getByRole('button', { name: '移除重排包' }));
  await userEvent.click(screen.getByRole('button', { name: '确认移除' }));
  await waitFor(() => expect(screen.getByText('尚未上传重排包')).toBeInTheDocument());

  // Close and reopen: the shelf refetched after removal, so the dialog must
  // derive the book from the list instead of a stale opening snapshot.
  await userEvent.click(screen.getByRole('button', { name: '取消' }));
  await userEvent.click(
    await screen.findByRole('button', { name: '编辑《带重排包的 PDF》' }),
  );

  expect(await screen.findByText('尚未上传重排包')).toBeInTheDocument();
  expect(screen.queryByText(/300 页/)).toBeNull();
});

it('lets a member create a category while editing a book', async () => {
  const router = createMemoryRouter(routes, { initialEntries: ['/'] });
  renderWithProviders(<RouterProvider router={router} />);

  await userEvent.click(
    await screen.findByRole('button', { name: '编辑《深入理解计算机系统》' }),
  );
  await userEvent.type(await screen.findByLabelText('新建分类'), '历史');
  await userEvent.click(screen.getByRole('button', { name: '创建分类' }));

  // The new category is selected immediately and appears in the list after the
  // categories query is invalidated.
  expect(await screen.findByRole('checkbox', { name: '历史' })).toBeChecked();
});
