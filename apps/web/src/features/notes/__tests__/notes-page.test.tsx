import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { routes } from '../../../app/router';
import { setTokens } from '../../../api/client';
import { note, renderWithProviders, server } from '../../../../test/setup';

// The notes page lives behind RequireAuth, so seed a stored session first.
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
  // The offline test installs an own property over jsdom's getter and the
  // query client tracks the last online/offline event, so restore both.
  Reflect.deleteProperty(navigator, 'onLine');
  window.dispatchEvent(new Event('online'));
});

const secondNote = note({
  id: 'note-2',
  type: 'highlight',
  color: 'green',
  locator: { kind: 'pdf', page: 7, percent: 0.2 },
  selectedText: '计算机系统是由硬件和软件组成的',
  noteText: null,
  tags: ['方法论'],
});

function twoNotes() {
  return {
    items: [note({ id: 'note-1' }), secondNote],
    total: 2,
    page: 1,
    pageSize: 30,
  };
}

function renderNotes() {
  const router = createMemoryRouter(routes, { initialEntries: ['/notes'] });
  return renderWithProviders(<RouterProvider router={router} />);
}

/** Local `YYYY-MM-DD` for `days` before today, mirroring the page's presets. */
function localDateDaysAgo(days: number): string {
  const date = new Date();
  date.setDate(date.getDate() - days);
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${date.getFullYear()}-${month}-${day}`;
}

it('renders notes with their book, position, quote, note and tags', async () => {
  renderNotes();

  const position = await screen.findByText('第 12 页');
  const card = position.closest('[data-testid="note-card"]') as HTMLElement;
  expect(within(card).getByText('深入理解计算机系统')).toBeInTheDocument();
  expect(within(card).getByText('程序的运行')).toBeInTheDocument();
  expect(within(card).getByText('指令与数据的边界')).toBeInTheDocument();
  expect(within(card).getByText('方法论')).toBeInTheDocument();

  expect(screen.getByRole('heading', { name: '笔记库' })).toBeInTheDocument();
  expect(screen.getByText('你写在所有书里的划线与批注')).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '笔记' })).toBeInTheDocument();
});

it('disables note actions while offline', async () => {
  Object.defineProperty(navigator, 'onLine', { configurable: true, value: true });
  window.dispatchEvent(new Event('online'));
  renderNotes();

  await screen.findByText('第 12 页');
  act(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });

  expect(
    await screen.findByText('离线时无法浏览笔记库，联网后会自动恢复。'),
  ).toBeInTheDocument();
  const card = screen.getAllByTestId('note-card')[0] as HTMLElement;
  expect(within(card).getByRole('button', { name: '编辑' })).toBeDisabled();
  expect(within(card).getByRole('button', { name: '删除' })).toBeDisabled();
  expect(within(card).getByRole('link', { name: '跳回原文' })).toHaveAttribute(
    'aria-disabled',
    'true',
  );
});

it('searches after the debounce and restarts the list', async () => {
  let lastUrl = '';
  server.use(
    http.get('/api/notes', ({ request }) => {
      lastUrl = request.url;
      const query = new URL(request.url).searchParams.get('q');
      return HttpResponse.json(
        query
          ? {
              items: [
                note({
                  id: 'note-fox',
                  selectedText: '狐狸',
                  noteText: '狐狸与葡萄',
                  locator: { kind: 'pdf', page: 3, percent: 0.1 },
                }),
              ],
              total: 1,
              page: 1,
              pageSize: 30,
            }
          : twoNotes(),
      );
    }),
  );

  renderNotes();
  expect(await screen.findByText('指令与数据的边界')).toBeInTheDocument();

  await userEvent.type(screen.getByLabelText('搜索笔记'), '狐狸');

  await waitFor(
    () => expect(new URL(lastUrl).searchParams.get('q')).toBe('狐狸'),
    { timeout: 3000 },
  );
  expect(await screen.findByText('狐狸与葡萄')).toBeInTheDocument();
  // The new query owns the list; stale rows from the previous key stay gone.
  await waitFor(() => expect(screen.queryByText('指令与数据的边界')).toBeNull());
});

it('sends book, tag, type and time filters', async () => {
  let lastUrl = '';
  server.use(
    http.get('/api/notes', ({ request }) => {
      lastUrl = request.url;
      return HttpResponse.json(twoNotes());
    }),
  );

  renderNotes();
  await screen.findByText('第 12 页');

  const bookSelect = screen.getByLabelText('按书筛选');
  await within(bookSelect).findByRole('option', { name: '深入理解计算机系统' });
  await userEvent.selectOptions(bookSelect, 'book-csapp');

  const tagSelect = screen.getByLabelText('按标签筛选');
  await within(tagSelect).findByRole('option', { name: '方法论' });
  await userEvent.selectOptions(tagSelect, '方法论');

  await userEvent.selectOptions(screen.getByLabelText('按类型筛选'), 'note');
  await userEvent.selectOptions(screen.getByLabelText('按时间筛选'), '7d');

  await waitFor(() => {
    const params = new URL(lastUrl).searchParams;
    expect(params.get('bookId')).toBe('book-csapp');
    expect(params.get('tag')).toBe('方法论');
    expect(params.get('type')).toBe('note');
    expect(params.get('from')).toBe(localDateDaysAgo(6));
  });
});

it('groups the loaded notes by book', async () => {
  renderNotes();
  await screen.findByText('第 12 页');

  await userEvent.click(screen.getByRole('button', { name: '按书分组' }));

  expect(
    await screen.findByRole('heading', { name: '《深入理解计算机系统》 · 2 条' }),
  ).toBeInTheDocument();
});

it('edits a note inline and refreshes the list', async () => {
  let patchBody: Record<string, unknown> | null = null;
  let listRequests = 0;
  server.use(
    http.get('/api/notes', () => {
      listRequests += 1;
      return HttpResponse.json(twoNotes());
    }),
    http.patch('/api/books/:bookId/annotations/:annotationId', async ({ params, request }) => {
      patchBody = (await request.json()) as Record<string, unknown>;
      return HttpResponse.json({
        annotation: {
          id: params.annotationId,
          bookId: params.bookId,
          ...patchBody,
        },
        conflict: false,
      });
    }),
  );

  renderNotes();
  const position = await screen.findByText('第 12 页');
  const card = position.closest('[data-testid="note-card"]') as HTMLElement;

  await userEvent.click(within(card).getByRole('button', { name: '编辑' }));
  const noteField = await screen.findByLabelText('批注内容');
  await userEvent.clear(noteField);
  await userEvent.type(noteField, '新的批注');

  const tagsField = screen.getByLabelText('标签（用逗号分隔）');
  await userEvent.clear(tagsField);
  await userEvent.type(tagsField, '方法论， 读书，读书');

  await userEvent.click(screen.getByRole('button', { name: '保存' }));

  await waitFor(() => expect(patchBody).not.toBeNull());
  expect(patchBody).toMatchObject({
    revision: 1,
    noteText: '新的批注',
    tags: ['方法论', '读书'],
  });
  await waitFor(() => expect(listRequests).toBeGreaterThanOrEqual(2));
  await waitFor(() => expect(screen.queryByLabelText('批注内容')).toBeNull());
});

it('confirms before deleting a note', async () => {
  let deleteUrl = '';
  server.use(
    http.get('/api/notes', () => HttpResponse.json(twoNotes())),
    http.delete('/api/books/:bookId/annotations/:annotationId', ({ request }) => {
      deleteUrl = request.url;
      return new HttpResponse(null, { status: 204 });
    }),
  );

  renderNotes();
  const position = await screen.findByText('第 12 页');
  const card = position.closest('[data-testid="note-card"]') as HTMLElement;

  await userEvent.click(within(card).getByRole('button', { name: '删除' }));
  expect(within(card).getByRole('button', { name: '确认删除？' })).toBeInTheDocument();
  expect(deleteUrl).toBe('');

  await userEvent.click(within(card).getByRole('button', { name: '确认删除？' }));
  await waitFor(() =>
    expect(deleteUrl).toContain('/api/books/book-csapp/annotations/note-1'),
  );
});

it('links each note back to its reader position', async () => {
  renderNotes();
  const position = await screen.findByText('第 12 页');
  const card = position.closest('[data-testid="note-card"]') as HTMLElement;

  expect(within(card).getByRole('link', { name: '跳回原文' })).toHaveAttribute(
    'href',
    '/books/book-csapp/read?note=note-1',
  );
});

it('exports with the active filters', async () => {
  let exportUrl = '';
  server.use(
    http.get('/api/notes/export', ({ request }) => {
      exportUrl = request.url;
      return new HttpResponse('# 笔记库\n', {
        headers: {
          'content-type': 'text/markdown; charset=utf-8',
          'content-disposition': `attachment; filename="notes.md"; filename*=UTF-8''${encodeURIComponent('笔记库.md')}`,
        },
      });
    }),
  );

  const createObjectURL = vi.fn(() => 'blob:notes');
  const revokeObjectURL = vi.fn();
  Object.defineProperty(URL, 'createObjectURL', {
    configurable: true,
    writable: true,
    value: createObjectURL,
  });
  Object.defineProperty(URL, 'revokeObjectURL', {
    configurable: true,
    writable: true,
    value: revokeObjectURL,
  });
  const downloaded = { href: '', download: '' };
  const clickSpy = vi
    .spyOn(HTMLAnchorElement.prototype, 'click')
    .mockImplementation(function (this: HTMLAnchorElement) {
      downloaded.href = this.href;
      downloaded.download = this.download;
    });

  renderNotes();
  await screen.findByText('第 12 页');

  await userEvent.type(screen.getByLabelText('搜索笔记'), '狐狸');
  // The default handler finds no match, so the empty state proves the debounced
  // query (and therefore `filters.q`) is already in effect before exporting.
  expect(await screen.findByRole('heading', { name: '还没有笔记' })).toBeInTheDocument();

  const tagSelect = screen.getByLabelText('按标签筛选');
  await within(tagSelect).findByRole('option', { name: '方法论' });
  await userEvent.selectOptions(tagSelect, '方法论');

  await userEvent.click(screen.getByRole('button', { name: '导出 Markdown' }));

  await waitFor(() => expect(exportUrl).not.toBe(''));
  const params = new URL(exportUrl).searchParams;
  expect(params.get('q')).toBe('狐狸');
  expect(params.get('tag')).toBe('方法论');

  expect(createObjectURL).toHaveBeenCalledTimes(1);
  expect(downloaded.download).toBe('笔记库.md');
  expect(downloaded.href).toContain('blob:notes');
  await waitFor(() => expect(revokeObjectURL).toHaveBeenCalledWith('blob:notes'));
  clickSpy.mockRestore();
});

it('shows the empty and offline states', async () => {
  server.use(
    http.get('/api/notes', () =>
      HttpResponse.json({ items: [], total: 0, page: 1, pageSize: 30 }),
    ),
  );

  renderNotes();

  expect(await screen.findByRole('heading', { name: '还没有笔记' })).toBeInTheDocument();
  expect(screen.getByRole('link', { name: '去书架挑一本书' })).toBeInTheDocument();

  act(() => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });

  expect(
    await screen.findByText('离线时无法浏览笔记库，联网后会自动恢复。'),
  ).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '导出 Markdown' })).toBeDisabled();
});
