import { expect, test } from '@playwright/test';
import type { Browser, BrowserContext, Page } from '@playwright/test';
import {
  E2E_BASE_URL,
  READER_PASSWORD,
  deleteE2EBooks,
  loginAs,
  openBook,
  registerFreshReader,
  revealChrome,
  uploadAndRename,
} from './helpers';

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

async function waitForPdfSpan(page: Page, needle: string): Promise<void> {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('.bookr-text-layer span')].some((node) =>
        node.textContent?.includes(text),
      ),
    needle,
  );
}

/** Resolves once the first page canvas and its selectable text are rendered. */
async function waitForPdfReady(page: Page): Promise<void> {
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({
    timeout: 15_000,
  });
  await waitForPdfSpan(page, SELECTED_PHRASE);
}

/** Selects the pdf.js text-layer span containing `needle`. */
async function selectPdfText(page: Page, needle: string): Promise<void> {
  await waitForPdfSpan(page, needle);
  await page.evaluate((text) => {
    const span = [...document.querySelectorAll('.bookr-text-layer span')].find((node) =>
      node.textContent?.includes(text),
    );
    if (!span) throw new Error(`text layer span not found: ${text}`);
    const range = document.createRange();
    range.selectNodeContents(span);
    const selection = window.getSelection();
    if (!selection) throw new Error('selection unavailable');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  }, needle);
}

/** Closes an open side panel so its header no longer covers the chrome. */
async function closePanel(page: Page, name: string): Promise<void> {
  const panel = page.getByRole('complementary', { name });
  await panel.getByRole('button', { name: '关闭' }).click();
  await expect(panel).toBeHidden();
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

  // Pinning downloads the original file (and its pack, when present).
  const card = page.getByTestId('book-card').filter({ hasText: PDF_TITLE });
  await card.getByRole('button', { name: `下载到本机《${PDF_TITLE}》` }).click();
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
