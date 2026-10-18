import 'fake-indexeddb/auto';
import '@testing-library/jest-dom/vitest';
import { LIBRARY_QUOTA_BYTES, MEMBER_UPLOAD_QUOTA_BYTES } from '@bookr/shared';
import type {
  AnnotationColor,
  AnnotationDto,
  AuthTokens,
  BookDto,
  BookmarkDto,
  BookStatus,
  CategoryDto,
  Locator,
  MeDto,
} from '@bookr/shared';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { render } from '@testing-library/react';
import type { RenderResult } from '@testing-library/react';
import { http, HttpResponse } from 'msw';
import { setupServer } from 'msw/node';
import { createElement } from 'react';
import type { ReactElement } from 'react';
import { afterAll, afterEach, beforeAll } from 'vitest';
import type { AdminInvite, AdminMember, StorageOverview } from '../src/api/admin';
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

export function book(overrides: Partial<BookDto> & Pick<BookDto, 'id' | 'title'>): BookDto {
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
    conversionError: null,
    reflowAvailable: false,
    reflowSchemaVersion: null,
    reflowPageCount: null,
    createdAt: new Date(now - 7 * DAY_MS).toISOString(),
    updatedAt: new Date(now - 2 * DAY_MS).toISOString(),
    deletedAt: null,
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

  const trashed = book({
    id: 'book-ddia',
    title: '设计数据密集型应用',
    author: 'Martin Kleppmann',
    format: 'epub',
    size: 5 * 1024 * 1024,
    status: 'finished',
    progressPercent: 100,
    categories: [computer],
    uploadedBy: { id: reader.id, displayName: reader.displayName },
    createdAt: new Date(now - 40 * DAY_MS).toISOString(),
    // `updatedAt` deliberately differs from `deletedAt`: retention must follow
    // the deletion instant, not the last metadata touch.
    updatedAt: new Date(now - 1 * DAY_MS).toISOString(),
    deletedAt: new Date(now - 10 * DAY_MS).toISOString(),
  });

  // The administration fixtures mirror the signed-in member (`reader`) plus an
  // administrator and a second member. Usage tracks the shelf fixtures above.
  const members: AdminMember[] = [
    {
      id: 'user-admin',
      username: 'keeper',
      displayName: '掌灯人',
      role: 'admin',
      isActive: true,
      uploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
      usedBytes: 0,
      createdAt: new Date(now - 90 * DAY_MS).toISOString(),
    },
    {
      id: reader.id,
      username: reader.username,
      displayName: reader.displayName,
      role: 'member',
      isActive: true,
      uploadQuotaBytes: MEMBER_UPLOAD_QUOTA_BYTES,
      usedBytes: 28 * 1024 * 1024,
      createdAt: new Date(now - 60 * DAY_MS).toISOString(),
    },
    {
      id: 'user-other',
      username: 'linzhou',
      displayName: '林舟',
      role: 'member',
      isActive: true,
      uploadQuotaBytes: 10 * 1024 * 1024 * 1024,
      usedBytes: 3 * 1024 * 1024,
      createdAt: new Date(now - 30 * DAY_MS).toISOString(),
    },
  ];

  // One invite per lifecycle state keeps the admin list honest in tests.
  const invites: AdminInvite[] = [
    {
      code: 'E7K2M9Q4XT',
      expiresAt: new Date(now + 2 * DAY_MS).toISOString(),
      usedBy: null,
      revokedAt: null,
    },
    {
      code: 'H3N8P5R2WY',
      expiresAt: new Date(now + 1 * DAY_MS).toISOString(),
      usedBy: 'user-other',
      revokedAt: null,
    },
    {
      code: 'S6T4V7Z9BD',
      expiresAt: new Date(now + 3 * DAY_MS).toISOString(),
      usedBy: null,
      revokedAt: new Date(now - DAY_MS).toISOString(),
    },
    {
      code: 'C2F5J8K3MQ',
      expiresAt: new Date(now - 2 * 60 * 60 * 1000).toISOString(),
      usedBy: null,
      revokedAt: null,
    },
  ];

  return {
    categories: [computer, literature],
    shelf,
    trash: [trashed] as BookDto[],
    members,
    invites,
    // Reader annotations and bookmarks start empty so Task 10's reader tests
    // keep seeing empty lists until a test seeds or creates its own.
    annotations: [] as AnnotationDto[],
    bookmarks: [] as BookmarkDto[],
    // Monotonic ids: deleting an item must not let its id be reused.
    nextIds: { annotation: 0, bookmark: 0 },
  };
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

/** Mirrors the server's storage overview, recomputed from the live fixtures. */
function storageFromMembers(members: AdminMember[]): StorageOverview {
  const perMember = members.map((member) => ({
    userId: member.id,
    displayName: member.displayName,
    usedBytes: member.usedBytes,
  }));
  return {
    totalBytes: LIBRARY_QUOTA_BYTES,
    usedBytes: perMember.reduce((sum, member) => sum + member.usedBytes, 0),
    perMember,
  };
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

  // Settings renders the AI section in several suites, so the defaults stay
  // permissive: AI on, configured, with fresh quotas.
  http.get('/api/ai/usage', () =>
    HttpResponse.json({
      enabled: true,
      configured: true,
      fakeProvider: false,
      model: 'deepseek-chat',
      daily: { used: 1000, reserved: 0, limit: 100_000 },
      monthly: { used: 5000, reserved: 0, limit: 1_000_000 },
    }),
  ),
  http.patch('/api/me/ai', async ({ request }) => {
    const body = (await request.json()) as { enabled: boolean };
    return HttpResponse.json({ enabled: body.enabled });
  }),

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
      removed.deletedAt = removed.updatedAt;
      fixtures.trash.unshift(removed);
    }
    return new HttpResponse(null, { status: 204 });
  }),
  http.post('/api/books/:id/restore', ({ params }) => {
    const index = fixtures.trash.findIndex((item) => item.id === params.id);
    if (index === -1) return error(404, 'NOT_FOUND', 'Book not found');
    const [restored] = fixtures.trash.splice(index, 1);
    if (!restored) return error(404, 'NOT_FOUND', 'Book not found');
    restored.deletedAt = null;
    restored.updatedAt = new Date().toISOString();
    fixtures.shelf.unshift(restored);
    return HttpResponse.json({ book: restored });
  }),
  http.post('/api/books/:id/convert', ({ params }) => {
    const found = fixtures.shelf.find((item) => item.id === params.id);
    if (!found) return error(404, 'NOT_FOUND', 'Book not found');
    found.conversionStatus = 'pending';
    found.conversionError = null;
    found.updatedAt = new Date().toISOString();
    return HttpResponse.json({ queued: true }, { status: 202 });
  }),
  // Reader file URLs follow the fixture format; MOBI/AZW3 fixtures use EPUB.
  http.get('/api/books/:id/file', ({ params }) => {
    const found = fixtures.shelf.find((item) => item.id === params.id);
    if (!found) return error(404, 'NOT_FOUND', 'Book not found');
    const format = found.format === 'pdf' ? 'pdf' : 'epub';
    return HttpResponse.json({
      url: format === 'pdf' ? 'https://files.test/book.pdf' : 'https://files.test/book.epub',
      format,
      expiresIn: 3600,
    });
  }),
  http.get('/api/books/:id/progress', () => HttpResponse.json({ progress: null })),
  http.put('/api/books/:id/progress', async ({ params, request }) => {
    const body = (await request.json()) as { locator: Locator };
    return HttpResponse.json({
      progress: {
        bookId: params.id,
        locator: body.locator,
        percent: body.locator.percent,
        updatedAt: new Date().toISOString(),
      },
    });
  }),

  // Reader annotations: the fixture array mutates like the server tables.
  http.get('/api/books/:id/annotations', ({ params }) =>
    HttpResponse.json({
      items: fixtures.annotations.filter((item) => item.bookId === params.id),
    }),
  ),
  http.post('/api/books/:id/annotations', async ({ params, request }) => {
    const input = (await request.json()) as {
      type?: 'highlight' | 'note';
      color?: AnnotationColor;
      locator?: Locator;
      selectedText?: string;
      noteText?: string | null;
      tags?: string[];
    };
    const now = new Date().toISOString();
    if (input.type === 'note' && (input.noteText ?? '').trim() === '') {
      return error(400, 'VALIDATION_FAILED', 'noteText is required for a note');
    }
    fixtures.nextIds.annotation += 1;
    const created: AnnotationDto = {
      id: `annotation-${fixtures.nextIds.annotation}`,
      bookId: String(params.id),
      type: input.type ?? 'highlight',
      color: input.color ?? 'yellow',
      locator: input.locator as Locator,
      selectedText: input.selectedText ?? '',
      noteText: input.noteText && input.noteText.trim() !== '' ? input.noteText.trim() : null,
      tags: input.tags ?? [],
      revision: 1,
      createdAt: now,
      updatedAt: now,
    };
    fixtures.annotations.unshift(created);
    return HttpResponse.json({ annotation: created }, { status: 201 });
  }),
  http.patch('/api/books/:id/annotations/:annotationId', async ({ params, request }) => {
    const input = (await request.json()) as {
      revision?: number;
      color?: AnnotationColor;
      noteText?: string | null;
      tags?: string[];
    };
    const found = fixtures.annotations.find(
      (item) => item.id === params.annotationId && item.bookId === params.id,
    );
    if (!found) return error(404, 'NOT_FOUND', 'Annotation not found');

    // Mirrors the server: a note can never be patched to a blank note text.
    if (
      found.type === 'note' &&
      input.noteText !== undefined &&
      (input.noteText === null || input.noteText.trim() === '')
    ) {
      return error(400, 'VALIDATION_FAILED', 'noteText is required for a note');
    }

    const conflict = input.revision !== undefined && input.revision !== found.revision;
    if (input.color !== undefined) found.color = input.color;
    if (input.noteText !== undefined) {
      found.noteText = input.noteText === null || input.noteText.trim() === ''
        ? null
        : input.noteText.trim();
    }
    if (input.tags !== undefined) found.tags = input.tags;
    found.revision += 1;
    found.updatedAt = new Date().toISOString();
    return HttpResponse.json({ annotation: { ...found }, conflict });
  }),
  http.delete('/api/books/:id/annotations/:annotationId', ({ params }) => {
    const index = fixtures.annotations.findIndex(
      (item) => item.id === params.annotationId && item.bookId === params.id,
    );
    if (index === -1) return error(404, 'NOT_FOUND', 'Annotation not found');
    fixtures.annotations.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
  }),

  // Reader bookmarks: same pattern, with an optional label.
  http.get('/api/books/:id/bookmarks', ({ params }) =>
    HttpResponse.json({
      items: fixtures.bookmarks.filter((item) => item.bookId === params.id),
    }),
  ),
  http.post('/api/books/:id/bookmarks', async ({ params, request }) => {
    const input = (await request.json()) as { locator?: Locator; label?: string | null };
    const now = new Date().toISOString();
    fixtures.nextIds.bookmark += 1;
    const created: BookmarkDto = {
      id: `bookmark-${fixtures.nextIds.bookmark}`,
      bookId: String(params.id),
      locator: input.locator as Locator,
      label: input.label ?? null,
      createdAt: now,
      updatedAt: now,
    };
    fixtures.bookmarks.unshift(created);
    return HttpResponse.json({ bookmark: created }, { status: 201 });
  }),
  http.patch('/api/books/:id/bookmarks/:bookmarkId', async ({ params, request }) => {
    const input = (await request.json()) as { label?: string | null };
    const found = fixtures.bookmarks.find(
      (item) => item.id === params.bookmarkId && item.bookId === params.id,
    );
    if (!found) return error(404, 'NOT_FOUND', 'Bookmark not found');

    found.label = input.label ?? null;
    found.updatedAt = new Date().toISOString();
    return HttpResponse.json({ bookmark: { ...found } });
  }),
  http.delete('/api/books/:id/bookmarks/:bookmarkId', ({ params }) => {
    const index = fixtures.bookmarks.findIndex(
      (item) => item.id === params.bookmarkId && item.bookId === params.id,
    );
    if (index === -1) return error(404, 'NOT_FOUND', 'Bookmark not found');
    fixtures.bookmarks.splice(index, 1);
    return new HttpResponse(null, { status: 204 });
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

  http.get('/api/admin/members', () => HttpResponse.json({ items: fixtures.members })),
  http.patch('/api/admin/members/:id', async ({ params, request }) => {
    const patch = (await request.json()) as {
      isActive?: boolean;
      uploadQuotaBytes?: number;
      password?: string;
    };
    const member = fixtures.members.find((item) => item.id === params.id);
    if (!member) return error(404, 'NOT_FOUND', 'Member not found');

    if (patch.isActive !== undefined) member.isActive = patch.isActive;
    if (patch.uploadQuotaBytes !== undefined) member.uploadQuotaBytes = patch.uploadQuotaBytes;
    // Passwords are hashed server-side; the summary never carries them.
    return HttpResponse.json({ ...member });
  }),
  http.get('/api/admin/invites', () => HttpResponse.json({ items: fixtures.invites })),
  http.post('/api/admin/invites', async ({ request }) => {
    const input = (await request.json().catch(() => ({}))) as { expiresInHours?: number };
    const expiresInHours = input.expiresInHours ?? 72;
    const code = `INV${String(fixtures.invites.length + 1).padStart(4, '0')}`;
    const created: AdminInvite = {
      code,
      expiresAt: new Date(Date.now() + expiresInHours * 60 * 60 * 1000).toISOString(),
      usedBy: null,
      revokedAt: null,
    };
    fixtures.invites.unshift(created);
    return HttpResponse.json(
      { code: created.code, expiresAt: created.expiresAt },
      { status: 201 },
    );
  }),
  http.delete('/api/admin/invites/:code', ({ params }) => {
    const invite = fixtures.invites.find((item) => item.code === params.code);
    if (!invite) return error(404, 'NOT_FOUND', 'Invite not found');
    invite.revokedAt = new Date().toISOString();
    return new HttpResponse(null, { status: 204 });
  }),
  http.get('/api/admin/storage', () =>
    HttpResponse.json(storageFromMembers(fixtures.members)),
  ),
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
