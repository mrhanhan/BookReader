import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';

const READER_PASSWORD = 'e2e-reader-password';
const READER_DISPLAY_NAME = '阅读端到端';
const PDF_TITLE = '端到端阅读 PDF';
const EPUB_TITLE = '端到端阅读 EPUB';
const PDF_FIXTURE = 'e2e/fixtures/reader.pdf';
const EPUB_FIXTURE = 'e2e/fixtures/reader.epub';
const READER_URL = /\/books\/[^/]+\/read$/;

interface FreshReader {
  username: string;
}

interface PersistedLocator {
  kind: string;
  page?: number;
  cfi?: string;
  href?: string;
  percent?: number;
}

interface PersistedProgress {
  locator: PersistedLocator;
  percent: number;
  updatedAt: string;
}

async function adminAuth(request: APIRequestContext): Promise<{ authorization: string }> {
  const login = await request.post('/api/auth/login', {
    data: { username: adminUsername, password: adminPassword },
  });
  expect(login.status(), 'admin login for invite minting').toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

/**
 * Mints an invite as the administrator and registers a fresh reader. Every
 * test gets its own identity, so runs never depend on state another test left
 * behind. Leftover books from an interrupted attempt are soft-deleted first:
 * sha256 dedupe spans the whole library and would block this run's upload.
 */
async function registerFreshReader(
  page: Page,
  request: APIRequestContext,
): Promise<FreshReader> {
  const headers = await adminAuth(request);

  // Walk every page before deleting: removing rows mid-walk would shift the
  // pagination and could leave a dedupe-blocking book behind.
  const leftovers: Array<{ id: string; uploadedBy: { displayName: string } }> = [];
  const pageSize = 100;
  let total = 0;
  for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
    const shelf = await request.get(`/api/books?page=${pageNumber}&pageSize=${pageSize}`, {
      headers,
    });
    expect(shelf.status(), 'list shelf for cleanup').toBe(200);
    const body = (await shelf.json()) as {
      items: Array<{ id: string; uploadedBy: { displayName: string } }>;
      total: number;
    };
    total = body.total;
    leftovers.push(...body.items);
    if (body.items.length === 0 || leftovers.length >= total) break;
  }
  expect(leftovers.length, 'read the whole shelf for cleanup').toBe(total);
  for (const item of leftovers) {
    if (item.uploadedBy.displayName !== READER_DISPLAY_NAME) continue;
    const cleaned = await request.delete(`/api/books/${item.id}`, { headers });
    expect(cleaned.status(), 'trash leftover E2E book').toBe(204);
  }

  const invite = await request.post('/api/admin/invites', {
    headers,
    data: { expiresInHours: 1 },
  });
  expect(invite.status(), 'create invite').toBe(201);
  const { code } = (await invite.json()) as { code: string };

  const username = `e2e_reader_${Date.now()}`;
  await page.goto('/register');
  await page.getByLabel('邀请码').fill(code);
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('显示名称').fill(READER_DISPLAY_NAME);
  await page.getByLabel('密码').fill(READER_PASSWORD);
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL('/');
  return { username };
}

/**
 * Uploads a fixture through the shelf dialog and renames the resulting card.
 * The metadata job may rename the filename title to the embedded one, so the
 * card is located by the fixture's "reader" stem rather than by position.
 */
async function uploadAndRename(page: Page, fixture: string, title: string): Promise<void> {
  await page.getByRole('button', { name: '上传图书' }).click();
  await page.setInputFiles('input[type=file]', fixture);
  await expect(page.getByText('上传完成')).toBeVisible({ timeout: 90_000 });

  const card = page.getByTestId('book-card').filter({ hasText: /reader/i }).first();
  await expect(card, 'uploaded card before it is renamed').toBeVisible();
  await card.getByRole('button', { name: /编辑《/ }).click();
  await page.getByLabel('书名').fill(title);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: /编辑《/ })).toBeHidden();
}

async function openBook(page: Page, title: string): Promise<string> {
  await page.getByRole('link', { name: `阅读《${title}》` }).click();
  await expect(page).toHaveURL(READER_URL);
  const match = new URL(page.url()).pathname.match(/^\/books\/([^/]+)\/read$/);
  if (!match?.[1]) throw new Error(`reader URL has no book id: ${page.url()}`);
  return match[1];
}

/** Signs in as the freshly registered reader to inspect the server-side state. */
async function readerAuth(
  request: APIRequestContext,
  username: string,
): Promise<{ authorization: string }> {
  const login = await request.post('/api/auth/login', {
    data: { username, password: READER_PASSWORD },
  });
  expect(login.status(), 'reader login for progress check').toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

async function readProgress(
  request: APIRequestContext,
  headers: { authorization: string },
  bookId: string,
): Promise<{ status: number; progress: PersistedProgress | null }> {
  const response = await request.get(`/api/books/${bookId}/progress`, { headers });
  if (!response.ok()) return { status: response.status(), progress: null };
  const body = (await response.json()) as { progress: PersistedProgress | null };
  return { status: response.status(), progress: body.progress };
}

/**
 * The reader saves on unmount, so the flush can still be in flight when the
 * shelf renders. Poll the API instead of racing a single request.
 */
async function waitForServerProgress(
  request: APIRequestContext,
  headers: { authorization: string },
  bookId: string,
  matches: (locator: PersistedLocator) => boolean,
): Promise<PersistedProgress> {
  await expect
    .poll(
      async () => {
        const { status, progress } = await readProgress(request, headers, bookId);
        return status === 200 && progress !== null && matches(progress.locator);
      },
      { timeout: 15_000, message: 'server-side progress is persisted' },
    )
    .toBe(true);

  const final = await readProgress(request, headers, bookId);
  expect(final.status, 'read persisted progress').toBe(200);
  expect(final.progress, 'persisted progress exists').not.toBeNull();
  return final.progress as PersistedProgress;
}

/** Drops any live DOM selection so a center tap is read as a tap, not a select. */
async function clearSelections(page: Page): Promise<void> {
  for (const frame of page.frames()) {
    await frame
      .evaluate(() => {
        window.getSelection()?.removeAllRanges();
      })
      .catch(() => {
        // A frame that detached mid-run cannot hold a selection.
      });
  }
}

/**
 * The chrome auto-hides after 2.5s of inactivity. A real pointer move reveals
 * it one-way, while a center tap toggles it. Playwright's `click()` moves the
 * pointer first, so tapping straight away would hide the chrome that move just
 * revealed; the tap is only a fallback for when the move cannot reach the
 * reading surface.
 */
async function revealChrome(page: Page): Promise<void> {
  const toc = page.getByRole('button', { name: '目录' });
  if (await toc.isVisible()) return;
  await clearSelections(page);
  const viewport = page.viewportSize() ?? { width: 1280, height: 720 };
  const center = { x: viewport.width / 2, y: viewport.height / 2 };
  // Two points guarantee a coordinate change even when the pointer already
  // sits on the reading surface (identical moves are ignored by the reader).
  await page.mouse.move(center.x - 8, center.y);
  await page.mouse.move(center.x, center.y);
  try {
    await expect(toc).toBeVisible({ timeout: 1_500 });
    return;
  } catch {
    // Fall through to the tap toggle below.
  }
  await page.getByTestId('reader-content').click();
  await expect(toc).toBeVisible();
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

/** Selects the pdf.js text-layer span containing `needle` and opens the menu. */
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

test('reads a PDF, highlights, annotates, bookmarks and restores progress', async ({
  page,
  request,
}) => {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, PDF_FIXTURE, PDF_TITLE);

  // First paint is measured from the navigation click until the page canvas
  // and its selectable text layer are both rendered.
  const started = Date.now();
  const bookId = await openBook(page, PDF_TITLE);
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({
    timeout: 10_000,
  });
  await waitForPdfSpan(page, 'quick brown fox');
  expect(Date.now() - started).toBeLessThan(10_000);

  await revealChrome(page);
  await expect(page.getByText(/第 1 \/ 300 页/)).toBeVisible();

  // Select the unique phrase in the pdf.js text layer and highlight it; the
  // marker must carry the yellow fill and surface as an annotation row.
  await selectPdfText(page, 'quick brown fox');
  await page.getByRole('button', { name: '用黄色划线' }).click();
  const marker = page.locator('.bookr-highlight-layer > div').first();
  await expect(marker).toBeVisible();
  await expect(marker).toHaveCSS('background-color', 'rgb(232, 197, 107)');

  await revealChrome(page);
  await page.getByRole('button', { name: '笔记' }).click();
  await expect(page.getByTestId('annotation-item')).toHaveCount(1);
  await closePanel(page, '笔记');

  // Go to page 3, leave the reader and verify the server stored page 3 rather
  // than only this browser's localStorage cache.
  await revealChrome(page);
  await page.getByLabel('页码').fill('3');
  await page.getByLabel('页码').press('Enter');
  await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible();

  await revealChrome(page);
  await page.getByRole('link', { name: '返回书架' }).click();
  await expect(page).toHaveURL('/');

  const progressAuth = await readerAuth(request, reader.username);
  const persisted = await waitForServerProgress(
    request,
    progressAuth,
    bookId,
    (locator) => locator.kind === 'pdf' && locator.page === 3,
  );
  expect(persisted.locator).toMatchObject({ kind: 'pdf', page: 3 });

  await page.getByRole('link', { name: `阅读《${PDF_TITLE}》` }).click();
  await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible({ timeout: 15_000 });

  // Add a note from a new selection and find it in the notes panel.
  await revealChrome(page);
  await selectPdfText(page, 'page three');
  await page.getByRole('button', { name: '写批注' }).click();
  await page.getByLabel('批注内容').fill('端到端批注');
  await page.getByRole('button', { name: '保存批注' }).click();
  await expect(page.getByLabel('批注内容')).toBeHidden();

  await revealChrome(page);
  await page.getByRole('button', { name: '笔记' }).click();
  await expect(page.getByTestId('annotation-item')).toHaveCount(2);
  await expect(page.getByText('端到端批注')).toBeVisible();

  // Bookmark page 3 and wait for the row before reloading, so the POST has
  // definitely landed.
  await closePanel(page, '笔记');
  await revealChrome(page);
  await page.getByRole('button', { name: '书签' }).click();
  await page.getByRole('button', { name: '添加书签' }).click();
  await page.getByLabel('书签备注').fill('第三页');
  await page.getByRole('button', { name: '保存书签' }).click();
  await expect(page.getByLabel('书签备注')).toBeHidden();
  await expect(page.getByTestId('bookmark-item').filter({ hasText: '第三页' })).toBeVisible();

  // After reload the reader restores page 3. Move away, then prove the
  // bookmark itself jumps back to page 3.
  await page.reload();
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({
    timeout: 15_000,
  });
  await revealChrome(page);
  await page.getByLabel('页码').fill('1');
  await page.getByLabel('页码').press('Enter');
  await expect(page.getByText(/第 1 \/ 300 页/)).toBeVisible();

  await revealChrome(page);
  await page.getByRole('button', { name: '书签' }).click();
  await page.getByRole('button', { name: '第三页', exact: true }).click();
  await expect(page.getByText(/第 3 \/ 300 页/)).toBeVisible();
});

test('reads an EPUB, jumps by TOC, highlights and restores the location', async ({
  page,
  request,
}) => {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, EPUB_FIXTURE, EPUB_TITLE);
  const bookId = await openBook(page, EPUB_TITLE);

  const frame = page.frameLocator('.reader-content iframe').first();
  await expect(frame.getByText('第一章正文', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Jump to the second chapter from the table of contents.
  await revealChrome(page);
  await page.getByRole('button', { name: '目录' }).click();
  await page.getByRole('button', { name: '第二章' }).click();
  await expect(frame.getByText('第二章正文', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // epub.js emits `selected` for a non-collapsed selection inside the iframe;
  // the highlight is painted as a mark in the rendition's view container.
  await frame.locator('body').evaluate((body) => {
    const range = document.createRange();
    range.selectNodeContents(body);
    const selection = window.getSelection();
    if (!selection) throw new Error('selection unavailable');
    selection.removeAllRanges();
    selection.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
    body.dispatchEvent(new MouseEvent('mouseup', { bubbles: true }));
  });
  await page.getByRole('button', { name: '用蓝色划线' }).click();
  await expect(page.locator('.bookr-epub-hl').first()).toBeVisible();

  await revealChrome(page);
  await page.getByRole('button', { name: '笔记' }).click();
  await expect(page.getByTestId('annotation-item')).toHaveCount(1);

  // Bookmark the chapter and wait for the row before reloading, so the POST
  // has definitely landed.
  await closePanel(page, '笔记');
  await revealChrome(page);
  await page.getByRole('button', { name: '书签' }).click();
  await page.getByRole('button', { name: '添加书签' }).click();
  await page.getByLabel('书签备注').fill('第二章');
  await page.getByRole('button', { name: '保存书签' }).click();
  await expect(page.getByLabel('书签备注')).toBeHidden();
  await expect(page.getByTestId('bookmark-item').filter({ hasText: '第二章' })).toBeVisible();

  // After reload the chapter is restored. Move away, then prove the bookmark
  // itself jumps back to chapter 2.
  await page.reload();
  const reloadedFrame = page.frameLocator('.reader-content iframe').first();
  await expect(reloadedFrame.getByText('第二章正文', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await revealChrome(page);
  await page.getByRole('button', { name: '目录' }).click();
  await page.getByRole('button', { name: '第一章' }).click();
  await expect(reloadedFrame.getByText('第一章正文', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await revealChrome(page);
  await page.getByRole('button', { name: '书签' }).click();
  await page.getByRole('button', { name: '第二章', exact: true }).click();
  await expect(reloadedFrame.getByText('第二章正文', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  // Leave and reopen: the chapter is restored and the footer knows the
  // position is past the start of the book. The open TOC panel keeps the
  // chrome (and the footer percentage) visible while it settles.
  await revealChrome(page);
  await page.getByRole('button', { name: '目录' }).click();
  await expect(page.locator('.reader-page-label')).toHaveText(/^[1-9][0-9]*%$/, {
    timeout: 15_000,
  });
  await closePanel(page, '目录');

  await revealChrome(page);
  await page.getByRole('link', { name: '返回书架' }).click();
  await expect(page).toHaveURL('/');

  const progressAuth = await readerAuth(request, reader.username);
  const persisted = await waitForServerProgress(
    request,
    progressAuth,
    bookId,
    (locator) =>
      locator.kind === 'epub' &&
      typeof locator.href === 'string' &&
      /ch2/.test(locator.href) &&
      (locator.percent ?? 0) > 0,
  );
  expect(persisted.locator.kind).toBe('epub');
  expect(persisted.locator.href).toContain('ch2');
  expect(persisted.locator.percent).toBeGreaterThan(0);
  expect(persisted.percent).toBeGreaterThan(0);

  await page.getByRole('link', { name: `阅读《${EPUB_TITLE}》` }).click();
  const reopenedFrame = page.frameLocator('.reader-content iframe').first();
  await expect(reopenedFrame.getByText('第二章正文', { exact: true })).toBeVisible({
    timeout: 15_000,
  });

  await revealChrome(page);
  await page.getByRole('button', { name: '目录' }).click();
  await expect(page.locator('.reader-page-label')).toHaveText(/^[1-9][0-9]*%$/, {
    timeout: 15_000,
  });
});
