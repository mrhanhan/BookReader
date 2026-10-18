import { expect, test } from '@playwright/test';
import type { APIRequestContext, Browser, BrowserContext, Page } from '@playwright/test';
import {
  E2E_BASE_URL,
  READER_PASSWORD,
  deleteE2EBooks,
  loginAs,
  openBook,
  readerAuth,
  registerFreshReader,
  revealChrome,
  selectPdfText,
  uploadAndRename,
  waitForPdfReady,
} from './helpers';
import type { AuthHeaders } from './helpers';

/**
 * Acceptance for the sync/offline phase. Every test registers its own reader
 * and uploads the fixture, then `afterEach` soft-deletes the book again: the
 * suite shares one real library and its sha256 dedupe spans the whole shelf.
 */
test.afterEach(async ({ request }) => {
  await deleteE2EBooks(request);
});

const PDF_TITLE = '端到端同步 PDF';
const PDF_FIXTURE = 'e2e/fixtures/reader.pdf';
const SELECTED_PHRASE = 'quick brown fox';
const OFFLINE_NOTE = '端到端离线批注';
const OFFLINE_BOOKMARK = '端到端离线书签';
const FIRST_SYNC_NOTE = '新设备首次同步批注';
const FIRST_SYNC_BOOKMARK = '新设备首次同步书签';

/**
 * A manually created context does not inherit `use.baseURL`, so the public
 * entry point is passed explicitly. Callers close the context when done.
 */
async function newDevice(
  browser: Browser,
): Promise<{ context: BrowserContext; page: Page }> {
  const context = await browser.newContext({ baseURL: E2E_BASE_URL });
  return { context, page: await context.newPage() };
}

/** Closes an open side panel so its header no longer covers the chrome. */
async function closePanel(page: Page, name: string): Promise<void> {
  const panel = page.getByRole('complementary', { name });
  await panel.getByRole('button', { name: '关闭' }).click();
  await expect(panel).toBeHidden();
}

interface ServerAnnotation {
  noteText: string | null;
  selectedText: string;
}

interface ServerBookmark {
  label: string | null;
}

interface ServerProgress {
  locator?: { kind?: string; page?: number };
}

/**
 * The fresh-device test must be sure the writes reached the server before the
 * second context logs in; otherwise the first-sync assertion would be vacuous.
 * These polls are what make that order explicit.
 */
async function waitForServerAnnotation(
  request: APIRequestContext,
  headers: AuthHeaders,
  bookId: string,
  noteText: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/books/${bookId}/annotations`, { headers });
        if (!response.ok()) return false;
        const body = (await response.json()) as { items: ServerAnnotation[] };
        return body.items.some((item) => item.noteText === noteText);
      },
      { timeout: 15_000, message: '批注已到达服务端' },
    )
    .toBe(true);
}

async function waitForServerBookmark(
  request: APIRequestContext,
  headers: AuthHeaders,
  bookId: string,
  label: string,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/books/${bookId}/bookmarks`, { headers });
        if (!response.ok()) return false;
        const body = (await response.json()) as { items: ServerBookmark[] };
        return body.items.some((item) => item.label === label);
      },
      { timeout: 15_000, message: '书签已到达服务端' },
    )
    .toBe(true);
}

async function waitForServerPage(
  request: APIRequestContext,
  headers: AuthHeaders,
  bookId: string,
  page: number,
): Promise<void> {
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/books/${bookId}/progress`, { headers });
        if (!response.ok()) return false;
        const body = (await response.json()) as { progress: ServerProgress | null };
        return body.progress?.locator?.kind === 'pdf' && body.progress.locator.page === page;
      },
      { timeout: 15_000, message: `阅读位置已到达服务端（第 ${page} 页）` },
    )
    .toBe(true);
}

test('同一账号的划线在另一台设备 5 秒内出现', async ({ browser, request }) => {
  test.setTimeout(120_000);
  const deviceA = await newDevice(browser);
  const deviceB = await newDevice(browser);

  try {
    const { username } = await registerFreshReader(deviceA.page, request);
    await uploadAndRename(deviceA.page, PDF_FIXTURE, PDF_TITLE);

    // Device B signs in as the same account and opens the book first, so the
    // mark has to arrive through the live stream instead of an initial pull.
    await loginAs(deviceB.page, username, READER_PASSWORD);
    await openBook(deviceB.page, PDF_TITLE);
    await waitForPdfReady(deviceB.page);

    await openBook(deviceA.page, PDF_TITLE);
    await waitForPdfReady(deviceA.page);

    await selectPdfText(deviceA.page, SELECTED_PHRASE);
    await deviceA.page.getByRole('button', { name: '用黄色划线' }).click();
    await expect(deviceA.page.locator('.bookr-highlight-layer > div').first()).toBeVisible();

    // Writes are pushed two seconds after the burst ends. The other device must
    // paint the mark within five seconds, without reloading or reopening.
    await expect(
      deviceB.page.locator('.bookr-highlight-layer > div').first(),
      '划线应在 5 秒内同步到另一台设备',
    ).toBeVisible({ timeout: 5_000 });
  } finally {
    await deviceA.context.close();
    await deviceB.context.close();
  }
});

test('离线写入在联网后合并到另一台设备', async ({ page, context, browser, request }) => {
  test.setTimeout(120_000);
  const deviceB = await newDevice(browser);

  try {
    const { username } = await registerFreshReader(page, request);
    await uploadAndRename(page, PDF_FIXTURE, PDF_TITLE);
    await openBook(page, PDF_TITLE);
    await waitForPdfReady(page);

    // Device B watches the same book from the start. Its notes panel stays
    // open, so anything that appears there arrived without user interaction.
    await loginAs(deviceB.page, username, READER_PASSWORD);
    await openBook(deviceB.page, PDF_TITLE);
    await waitForPdfReady(deviceB.page);
    await revealChrome(deviceB.page);
    await deviceB.page.getByRole('button', { name: '笔记' }).click();
    await expect(deviceB.page.getByTestId('annotation-item')).toHaveCount(0);

    await context.setOffline(true);
    await expect.poll(() => page.evaluate(() => navigator.onLine)).toBe(false);

    // A note created while offline must be readable from the local store.
    await selectPdfText(page, SELECTED_PHRASE);
    await page.getByRole('button', { name: '写批注' }).click();
    await page.getByLabel('批注内容').fill(OFFLINE_NOTE);
    await page.getByRole('button', { name: '保存批注' }).click();
    await expect(page.getByLabel('批注内容')).toBeHidden();

    await revealChrome(page);
    await page.getByRole('button', { name: '笔记' }).click();
    await expect(
      page.getByTestId('annotation-item').filter({ hasText: OFFLINE_NOTE }),
    ).toBeVisible();
    await expect(page.getByText('离线待同步')).toBeVisible();
    await closePanel(page, '笔记');

    // A bookmark is local-only as well.
    await revealChrome(page);
    await page.getByRole('button', { name: '书签' }).click();
    await page.getByRole('button', { name: '添加书签' }).click();
    await page.getByLabel('书签备注').fill(OFFLINE_BOOKMARK);
    await page.getByRole('button', { name: '保存书签' }).click();
    await expect(page.getByLabel('书签备注')).toBeHidden();
    await expect(
      page.getByTestId('bookmark-item').filter({ hasText: OFFLINE_BOOKMARK }),
    ).toBeVisible();
    await closePanel(page, '书签');

    // Reconnecting does not wake the engine by itself; a visible document does.
    await context.setOffline(false);
    await page.evaluate(() => document.dispatchEvent(new Event('visibilitychange')));

    await expect(
      deviceB.page.getByTestId('annotation-item').filter({ hasText: OFFLINE_NOTE }),
      '离线批注应在重连后 15 秒内到达另一台设备',
    ).toBeVisible({ timeout: 15_000 });

    await revealChrome(deviceB.page);
    await closePanel(deviceB.page, '笔记');
    await revealChrome(deviceB.page);
    await deviceB.page.getByRole('button', { name: '书签' }).click();
    await expect(
      deviceB.page.getByTestId('bookmark-item').filter({ hasText: OFFLINE_BOOKMARK }),
      '离线书签应在重连后 15 秒内到达另一台设备',
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await context.setOffline(false);
    await deviceB.context.close();
  }
});

test('下载到本机的书离线可读，清理缓存后明确提示', async ({ page, context, request }) => {
  test.setTimeout(180_000);
  await registerFreshReader(page, request);
  await uploadAndRename(page, PDF_FIXTURE, PDF_TITLE);
  await openBook(page, PDF_TITLE);
  await waitForPdfReady(page);

  await revealChrome(page);
  await page.getByRole('link', { name: '返回书架' }).click();
  await expect(page).toHaveURL('/');

  // Pinning downloads the original file (and its pack, when present). Opening
  // the book online already cached a copy, so the 离线 badge can appear before
  // this click lands; wait for the visible pinned state instead.
  const card = page.getByTestId('book-card').filter({ hasText: PDF_TITLE });
  await card.getByRole('button', { name: `下载到本机《${PDF_TITLE}》` }).click();
  await expect(
    card.getByRole('button', { name: `取消固定《${PDF_TITLE}》` }),
    '手动下载已固定该书',
  ).toBeVisible({ timeout: 15_000 });
  await expect(card.getByText('离线', { exact: true })).toBeVisible({ timeout: 30_000 });

  await context.setOffline(true);
  const reloaded = await page
    .reload({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  expect(reloaded, '离线重载需要应用外壳被 PWA / Service Worker 缓存').toBe(true);

  // The shelf falls back to its local snapshot, then the downloaded copy opens.
  await openBook(page, PDF_TITLE);
  await waitForPdfReady(page);
  await revealChrome(page);
  await expect(page.getByText(/第 1 \/ 300 页/)).toBeVisible();
  await expect(page.getByText('离线', { exact: true })).toBeVisible();

  // Drop the pinned copy from the settings page; reading data is left alone.
  await revealChrome(page);
  await page.getByRole('link', { name: '返回书架' }).click();
  await expect(page).toHaveURL('/');
  await page.getByRole('link', { name: '设置' }).click();
  await expect(page.getByRole('heading', { name: '设置' })).toBeVisible();

  await page.getByRole('switch', { name: `固定《${PDF_TITLE}》` }).click();
  await expect(page.getByText(`《${PDF_TITLE}》已取消固定`)).toBeVisible();
  await page.getByRole('button', { name: `将《${PDF_TITLE}》移出本机` }).click();
  await expect(page.getByText(`《${PDF_TITLE}》已移出本机`)).toBeVisible();

  // The copy is gone, so the reader names the missing download instead of
  // showing a blank page.
  await page.getByRole('link', { name: '书架' }).click();
  await expect(page).toHaveURL('/');
  await openBook(page, PDF_TITLE);
  await expect(page.getByText('这本书尚未下载到本机')).toBeVisible({ timeout: 15_000 });
});

test('新设备首次同步即看到批注、书签与阅读位置', async ({ page, browser, request }) => {
  test.setTimeout(150_000);
  const deviceB = await newDevice(browser);

  try {
    const { username } = await registerFreshReader(page, request);
    await uploadAndRename(page, PDF_FIXTURE, PDF_TITLE);
    const bookId = await openBook(page, PDF_TITLE);
    await waitForPdfReady(page);

    // Device A writes a note, a bookmark and moves to page 3.
    await selectPdfText(page, SELECTED_PHRASE);
    await page.getByRole('button', { name: '写批注' }).click();
    await page.getByLabel('批注内容').fill(FIRST_SYNC_NOTE);
    await page.getByRole('button', { name: '保存批注' }).click();
    await expect(page.getByLabel('批注内容')).toBeHidden();

    await revealChrome(page);
    await page.getByRole('button', { name: '书签' }).click();
    await page.getByRole('button', { name: '添加书签' }).click();
    await page.getByLabel('书签备注').fill(FIRST_SYNC_BOOKMARK);
    await page.getByRole('button', { name: '保存书签' }).click();
    await expect(page.getByLabel('书签备注')).toBeHidden();
    await expect(
      page.getByTestId('bookmark-item').filter({ hasText: FIRST_SYNC_BOOKMARK }),
    ).toBeVisible();
    await closePanel(page, '书签');

    await revealChrome(page);
    await page.getByLabel('页码').fill('3');
    await page.getByLabel('页码').press('Enter');
    await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible();

    // Leaving the reader flushes the buffered position and requests a sync.
    await revealChrome(page);
    await page.getByRole('link', { name: '返回书架' }).click();
    await expect(page).toHaveURL('/');

    // Only once all three are on the server can a brand-new device learn about
    // them exclusively through its first sync.
    const auth = await readerAuth(request, username, READER_PASSWORD);
    await waitForServerAnnotation(request, auth, bookId, FIRST_SYNC_NOTE);
    await waitForServerBookmark(request, auth, bookId, FIRST_SYNC_BOOKMARK);
    await waitForServerPage(request, auth, bookId, 3);

    // A second context has empty storage and an empty local database.
    await loginAs(deviceB.page, username, READER_PASSWORD);
    await openBook(deviceB.page, PDF_TITLE);
    // The book opens at page 3 because the first sync brought the position.
    await expect(deviceB.page.locator('.bookr-pdf-page canvas').first()).toBeVisible({
      timeout: 15_000,
    });
    await revealChrome(deviceB.page);
    await expect(
      deviceB.page.getByText(/第 3 \/ 300 页/),
      '新设备按首次同步的位置打开',
    ).toBeVisible({ timeout: 15_000 });

    await deviceB.page.getByRole('button', { name: '笔记' }).click();
    await expect(
      deviceB.page.getByTestId('annotation-item').filter({ hasText: FIRST_SYNC_NOTE }),
      '新设备通过首次同步看到批注',
    ).toBeVisible({ timeout: 15_000 });
    await closePanel(deviceB.page, '笔记');

    await revealChrome(deviceB.page);
    await deviceB.page.getByRole('button', { name: '书签' }).click();
    await expect(
      deviceB.page.getByTestId('bookmark-item').filter({ hasText: FIRST_SYNC_BOOKMARK }),
      '新设备通过首次同步看到书签',
    ).toBeVisible({ timeout: 15_000 });
  } finally {
    await deviceB.context.close();
  }
});

test('在线打开过的书自动缓存，断网 reload 后仍可打开', async ({
  page,
  context,
  request,
}) => {
  test.setTimeout(180_000);
  await registerFreshReader(page, request);
  await uploadAndRename(page, PDF_FIXTURE, PDF_TITLE);

  // Opening the book online is the only caching trigger: no 下载到本机 click.
  await openBook(page, PDF_TITLE);
  await waitForPdfReady(page);

  await revealChrome(page);
  await page.getByRole('link', { name: '返回书架' }).click();
  await expect(page).toHaveURL('/');

  const card = page.getByTestId('book-card').filter({ hasText: PDF_TITLE });
  // The background copy lands on its own; the badge is the visible signal.
  await expect(card.getByText('离线', { exact: true })).toBeVisible({ timeout: 30_000 });
  // Automatic caching neither pins the book nor counts as a manual download.
  await expect(card.getByRole('button', { name: `取消固定《${PDF_TITLE}》` })).toHaveCount(0);

  await context.setOffline(true);
  const reloaded = await page
    .reload({ timeout: 15_000 })
    .then(() => true)
    .catch(() => false);
  expect(reloaded, '离线重载需要应用外壳被 PWA / Service Worker 缓存').toBe(true);

  await openBook(page, PDF_TITLE);
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({
    timeout: 15_000,
  });
  await revealChrome(page);
  await expect(page.getByText(/第 1 \/ 300 页/)).toBeVisible();
  await expect(page.getByText('离线', { exact: true })).toBeVisible();
});

