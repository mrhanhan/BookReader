import '@testing-library/jest-dom/vitest';
import { LIBRARY_QUOTA_BYTES, MEMBER_UPLOAD_QUOTA_BYTES } from '@bookr/shared';
import type { AuthTokens, BookDto, BookStatus, CategoryDto, MeDto } from '@bookr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import { AuthProvider } from '../src/app/auth';

const tokens: AuthTokens = {
  accessToken: 'test-access-token',
  refreshToken: 'test-refresh-token-which-is-long-enough',
  expiresIn: 900,
};

const reader: MeDto = {
  id: 'user-reader',
  username: 'reader',
  displayName: '读者',
  role: 'member',
  timezone: 'Asia/Shanghai',
  aiEnabled: false,
  uploadUsedBytes: 0,
  uploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
  libraryUsedBytes: 0,
  libraryQuotaBytes: LIBRARY_QUOTA_BYTES,
};

const error = (status: number, code: string, message: string) =>
  HttpResponse.json({ error: { code, message } }, { status });

const DAY_MS = 24 * 60 * 60 * 1000;

function book(overrides: Partial<BookDto> & Pick<BookDto, 'id' | 'title'>): BookDto {
  const now = Date.now();
  return {
    author: null,
    description: null,
    format: 'pdf',
    size: 1024 * 1024,
    coverUrl: null,
    status: 'unread',
    progressPercent: 0,
    categories: [],
    uploadedBy: { id: 'user-other', displayName: '林舟' },
    conversionStatus: 'none',
    createdAt: new Date(now - 7 * DAY_MS).toISOString(),
    updatedAt: new Date(now - 2 * DAY_MS).toISOString(),
    ...overrides,
  };
}

/**
 * Mutable fixture state shared by the handlers. Tests can exercise real
 * shelves by deleting/restoring through the UI; `resetFixtures` restores the
 * seed between tests because `server.resetHandlers()` only drops overrides.
 */
function createFixtureState() {
  const computer: CategoryDto = { id: 'cat-computer', name: '计算机', color: '#8C5A3B' };
  const literature: CategoryDto = { id: 'cat-literature', name: '文学', color: '#3B6E8C' };
  const now = Date.now();

  const shelf: BookDto[] = [
    book({
      id: 'book-csapp',
      title: '深入理解计算机系统',
      author: 'Randal E. Bryant',
      description: '从程序员的视角理解计算机系统。',
      format: 'pdf',
      size: 28 * 1024 * 1024,
      status: 'reading',
      progressPercent: 42,
      categories: [computer],
      uploadedBy: { id: reader.id, displayName: reader.displayName },
      createdAt: new Date(now - 12 * DAY_MS).toISOString(),
      updatedAt: new Date(now - 1 * DAY_MS).toISOString(),
    }),
    book({
      id: 'book-three-body',
      title: '三体',
      author: '刘慈欣',
      description: '地球往事三部曲的第一部。',
      format: 'epub',
      size: 3 * 1024 * 1024,
      status: 'unread',
      progressPercent: 0,
      categories: [literature],
      uploadedBy: { id: 'user-other', displayName: '林舟' },
      createdAt: new Date(now - 4 * DAY_MS).toISOString(),
      updatedAt: new Date(now - 3 * DAY_MS).toISOString(),
    }),
  ];

  return { categories: [computer, literature], shelf, trash: [] as BookDto[] };
}

let fixtures = createFixtureState();

function resetFixtures(): void {
  fixtures = createFixtureState();
}

function matchesText(value: string | null, search: string): boolean {
  return (value ?? '').toLowerCase().includes(search.toLowerCase());
}

/** Mirrors the server's filter, sort and pagination rules for the shelf. */
function listBooksFromUrl(url: string): {
  items: BookDto[];
  total: number;
  page: number;
  pageSize: number;
} {
  const params = new URL(url).searchParams;
  const search = params.get('query')?.trim() ?? '';
  const format = params.get('format');
  const status = params.get('status');
  const categoryId = params.get('categoryId');

  let items = fixtures.shelf.filter((item) => {
    if (search && !matchesText(item.title, search) && !matchesText(item.author, search)) {
      return false;
    }
    if (format && item.format !== format) return false;
    if (status && item.status !== status) return false;
    if (categoryId && !item.categories.some((category) => category.id === categoryId)) {
      return false;
    }
    return true;
  });

  const sort = params.get('sort') ?? 'recent';
  items = [...items].sort((left, right) => {
    if (sort === 'title') return left.title.localeCompare(right.title, 'zh-Hans-CN');
    const field = sort === 'added' ? 'createdAt' : 'updatedAt';
    return new Date(right[field]).getTime() - new Date(left[field]).getTime();
  });

  const page = Number(params.get('page') ?? 1);
  const pageSize = Number(params.get('pageSize') ?? 24);
  const start = (page - 1) * pageSize;
  return { items: items.slice(start, start + pageSize), total: items.length, page, pageSize };
}

export const handlers = [
  http.post('/api/auth/login', async ({ request }) => {
    const body = (await request.json()) as { username?: string; password?: string };
    if (body.username === 'reader' && body.password === 'correct-password') {
      return HttpResponse.json(tokens);
    }
    return error(401, 'UNAUTHORIZED', '用户名或密码错误');
  }),
  http.post('/api/auth/register', () => HttpResponse.json(tokens, { status: 201 })),
  http.post('/api/auth/refresh', () => HttpResponse.json(tokens)),
  http.post('/api/auth/logout', () => new HttpResponse(null, { status: 204 })),
  http.get('/api/auth/me', () => HttpResponse.json(reader)),

  http.get('/api/books', ({ request }) => HttpResponse.json(listBooksFromUrl(request.url))),
  http.get('/api/books/:id', ({ params }) => {
    const found = fixtures.shelf.find((item) => item.id === params.id);
    return found ? HttpResponse.json({ book: found }) : error(404, 'NOT_FOUND', 'Book not found');
  }),
  http.patch('/api/books/:id', async ({ params, request }) => {
    const patch = (await request.json()) as {
      title?: string;
      author?: string | null;
      description?: string | null;
      status?: BookStatus;
      categoryIds?: string[];
    };
    const found = fixtures.shelf.find((item) => item.id === params.id);
    if (!found) return error(404, 'NOT_FOUND', 'Book not found');

    if (patch.title !== undefined) found.title = patch.title;
    if (patch.author !== undefined) found.author = patch.author;
    if (patch.description !== undefined) found.description = patch.description;
    if (patch.status !== undefined) found.status = patch.status;
    if (patch.categoryIds !== undefined) {
      found.categories = patch.categoryIds
        .map((id) => fixtures.categories.find((category) => category.id === id))
        .filter((category): category is CategoryDto => category !== undefined);
    }
    found.updatedAt = new Date().toISOString();
    return HttpResponse.json({ book: found });
  }),
  http.delete('/api/books/:id', ({ params }) => {
    const index = fixtures.shelf.findIndex((item) => item.id === params.id);
    if (index === -1) return error(404, 'NOT_FOUND', 'Book not found');
    const [removed] = fixtures.shelf.splice(index, 1);
    if (removed) {
      removed.updatedAt = new Date().toISOString();
      fixtures.trash.unshift(removed);
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/books/:id/restore', ({ params }) => {
    const index = fixtures.trash.findIndex((item) => item.id === params.id);
    if (index === -1) return error(404, 'NOT_FOUND', 'Book not found');
    const [restored] = fixtures.trash.splice(index, 1);
    if (!restored) return error(404, 'NOT_FOUND', 'Book not found');
    restored.updatedAt = new Date().toISOString();
    fixtures.shelf.unshift(restored);
    return HttpResponse.json({ book: restored });
  }),
  http.post('/api/books/:id/cover', async ({ params, request }) => {
    const found = fixtures.shelf.find((item) => item.id === params.id);
    if (!found) return error(404, 'NOT_FOUND', 'Book not found');
    const form = await request.formData();
    const file = form.get('cover');
    if (!file || typeof file === 'string') {
      return error(400, 'VALIDATION_FAILED', 'A cover image is required');
    }
    found.coverUrl = `https://covers.test/${found.id}.png`;
    found.updatedAt = new Date().toISOString();
    return HttpResponse.json({ coverUrl: found.coverUrl });
  }),

  http.get('/api/trash', () => HttpResponse.json({ items: fixtures.trash })),
  http.get('/api/categories', () => HttpResponse.json({ items: fixtures.categories })),
  http.post('/api/categories', async ({ request }) => {
    const input = (await request.json()) as { name: string; color: string };
    const created: CategoryDto = {
      id: `cat-${fixtures.categories.length + 1}`,
      name: input.name,
      color: input.color,
    };
    fixtures.categories.push(created);
    return HttpResponse.json(created, { status: 201 });
  }),
];

export const server = setupServer(...handlers);

beforeAll(() => {
  server.listen({ onUnhandledRequest: 'error' });
});

afterEach(() => {
  server.resetHandlers();
  resetFixtures();
  localStorage.clear();
});

afterAll(() => {
  server.close();
});

/** Renders a subtree with the query client and auth context the app expects. */
export function renderWithProviders(ui: ReactElement): RenderResult & { queryClient: QueryClient } {
  const queryClient = new QueryClient({
    defaultOptions: {
      queries: { retry: false },
      mutations: { retry: false },
    },
  });

  return {
    queryClient,
    ...render(
      createElement(
        QueryClientProvider,
        { client: queryClient },
        createElement(AuthProvider, null, ui),
      ),
    ),
  };
}
