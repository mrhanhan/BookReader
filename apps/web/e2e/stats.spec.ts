import { expect, test } from '@playwright/test';
import type { APIRequestContext } from '@playwright/test';
import {
  deleteE2EBooks,
  readerAuth,
  registerFreshReader,
  uploadAndRename,
} from './helpers';
import type { AuthHeaders } from './helpers';

/**
 * Acceptance for reading time and the streak page. Sessions are pushed through
 * the real sync endpoint (the same path the reader uses), then the page is
 * inspected. Every test registers its own reader and removes its book again.
 */
const TITLE = '端到端统计';
const FIXTURE = 'e2e/fixtures/reader.pdf';
const SHANGHAI = 'Asia/Shanghai';

test.afterEach(async ({ request }) => {
  await deleteE2EBooks(request);
});

function shanghaiDate(daysAgo: number): string {
  const date = new Date();
  date.setUTCDate(date.getUTCDate() - daysAgo);
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: SHANGHAI,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(date);
}

/** A finished 12:00 session on the given local day (Shanghai is fixed +08:00). */
function session(date: string, activeSeconds: number) {
  const hours = activeSeconds / 3600;
  const end = 12 + hours;
  return {
    startedAt: `${date}T12:00:00+08:00`,
    endedAt: `${date}T${String(Math.floor(end)).padStart(2, '0')}:${String(
      Math.round((end % 1) * 60),
    ).padStart(2, '0')}:00+08:00`,
    activeSeconds,
    pagesRead: 12,
  };
}

async function pushSession(
  request: APIRequestContext,
  headers: AuthHeaders,
  bookId: string,
  data: ReturnType<typeof session>,
): Promise<void> {
  const response = await request.post('/api/sync/push', {
    headers,
    data: {
      changes: [
        {
          entityType: 'reading_session',
          entityId: crypto.randomUUID(),
          op: 'upsert',
          clientUpdatedAt: new Date().toISOString(),
          payload: { bookId, ...data },
        },
      ],
    },
  });
  expect(response.status(), 'push reading session').toBe(200);
  const body = (await response.json()) as { rejected: unknown[]; applied: unknown[] };
  expect(body.rejected).toEqual([]);
  expect(body.applied).toHaveLength(1);
}

async function findBookId(
  request: APIRequestContext,
  headers: AuthHeaders,
  title: string,
): Promise<string> {
  const response = await request.get('/api/books?page=1&pageSize=100', { headers });
  expect(response.status()).toBe(200);
  const body = (await response.json()) as { items: Array<{ id: string; title: string }> };
  const book = body.items.find((item) => item.title === title);
  if (!book) throw new Error(`uploaded book "${title}" was not found`);
  return book.id;
}

test('counts a qualified day and draws the thirty-day chart', async ({ page, request }) => {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await findBookId(request, await readerAuth(request, reader.username), TITLE);
  const headers = await readerAuth(request, reader.username);

  await pushSession(request, headers, bookId, session(shanghaiDate(0), 1_200));

  // Phones are the primary target: the page must not scroll sideways at 360px.
  await page.setViewportSize({ width: 360, height: 800 });
  await page.goto('/stats');
  expect(await page.getByRole('heading', { name: '统计' })).toBeVisible();

  const overflow = await page.evaluate(
    () => document.documentElement.scrollWidth - document.documentElement.clientWidth,
  );
  expect(overflow).toBeLessThanOrEqual(1);

  const streak = (await page.getByRole('region', { name: '连续阅读' }).textContent()) ?? '';
  expect(streak).toContain('1');
  expect(await page.getByText('20 分钟').first()).toBeVisible();
  expect(page.getByRole('list', { name: '每日阅读时长' }).getByRole('listitem')).toHaveCount(30);
  expect(await page.getByText(`${TITLE}`).first()).toBeVisible();
});

test('adds consecutive qualified days into one streak', async ({ page, request }) => {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const headers = await readerAuth(request, reader.username);
  const bookId = await findBookId(request, headers, TITLE);

  await pushSession(request, headers, bookId, session(shanghaiDate(2), 900));
  await pushSession(request, headers, bookId, session(shanghaiDate(1), 900));
  await pushSession(request, headers, bookId, session(shanghaiDate(0), 1_200));

  await page.goto('/stats');
  await expect(page.getByRole('heading', { name: '统计' })).toBeVisible();

  const streak = (await page.getByRole('region', { name: '连续阅读' }).textContent()) ?? '';
  expect(streak).toContain('3');
  expect(await page.getByText('3 天', { exact: true })).toBeVisible();
  expect(await page.getByText(TITLE).first()).toBeVisible();
});
