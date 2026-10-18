import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect } from '@playwright/test';
import type { APIRequestContext, Page, Response } from '@playwright/test';

const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';

/**
 * Public entry point of the disposable stack. Contexts created by hand with
 * `browser.newContext()` do not inherit `use.baseURL`, so multi-device tests
 * pass this value explicitly.
 */
export const E2E_BASE_URL = process.env.E2E_BASE_URL ?? 'http://localhost:8180';

export const READER_PASSWORD = 'e2e-reader-password';
const READER_DISPLAY_NAME = '阅读端到端';
const READER_URL = /\/books\/[^/]+\/read$/;

export interface FreshReader {
  username: string;
}

/** A type alias, not an interface, so it is assignable to `Record<string, string>`. */
export type AuthHeaders = { authorization: string };

export async function adminAuth(
  request: APIRequestContext,
): Promise<AuthHeaders> {
  const login = await request.post('/api/auth/login', {
    data: { username: adminUsername, password: adminPassword },
  });
  expect(login.status(), 'admin login for invite minting').toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

interface ShelfBookRow {
  id: string;
  uploadedBy: { displayName: string };
}

/**
 * Reads every shelf page before deleting anything: removing rows mid-walk
 * would shift the pagination and could leave a dedupe-blocking book behind.
 */
async function readWholeShelf(
  request: APIRequestContext,
  headers: AuthHeaders,
): Promise<ShelfBookRow[]> {
  const items: ShelfBookRow[] = [];
  const pageSize = 100;
  let total = 0;
  for (let pageNumber = 1; pageNumber <= 50; pageNumber += 1) {
    const shelf = await request.get(`/api/books?page=${pageNumber}&pageSize=${pageSize}`, {
      headers,
    });
    expect(shelf.status(), 'list shelf for cleanup').toBe(200);
    const body = (await shelf.json()) as { items: ShelfBookRow[]; total: number };
    total = body.total;
    items.push(...body.items);
    if (body.items.length === 0 || items.length >= total) break;
  }
  expect(items.length, 'read the whole shelf for cleanup').toBe(total);
  return items;
}

async function deleteReaderBooks(
  request: APIRequestContext,
  headers: AuthHeaders,
): Promise<void> {
  for (const item of await readWholeShelf(request, headers)) {
    if (item.uploadedBy.displayName !== READER_DISPLAY_NAME) continue;
    const cleaned = await request.delete(`/api/books/${item.id}`, { headers });
    expect(cleaned.status(), 'trash leftover E2E book').toBe(204);
  }
}

/**
 * Soft-deletes every book uploaded by the E2E reader account. Sync tests call
 * this in `afterEach` so an interrupted run cannot leave a book that blocks
 * the next upload (sha256 dedupe spans the whole library).
 */
export async function deleteE2EBooks(request: APIRequestContext): Promise<void> {
  await deleteReaderBooks(request, await adminAuth(request));
}

/**
 * Mints an invite as the administrator and registers a fresh reader. Every
 * test gets its own identity, so runs never depend on state another test left
 * behind. Leftover books from an interrupted attempt are soft-deleted first:
 * sha256 dedupe spans the whole library and would block this run's upload.
 */
export async function registerFreshReader(
  page: Page,
  request: APIRequestContext,
): Promise<FreshReader> {
  const headers = await adminAuth(request);
  await deleteReaderBooks(request, headers);

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
 * Signs an already-registered account in through the real login form. A second
 * browser context has empty storage, so the multi-device tests log in again
 * with the credentials the first context registered.
 */
export async function loginAs(
  page: Page,
  username: string,
  password: string = READER_PASSWORD,
): Promise<void> {
  await page.goto('/login');
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('密码').fill(password);
  await page.getByRole('button', { name: '登录' }).click();
  await expect(page).toHaveURL('/');
}

interface DuplicateBookBody {
  error?: { code?: string; details?: { existingBookId?: string } };
}

/**
 * Turns a `DUPLICATE_BOOK` rejection into an operator-facing instruction. The
 * server only returns the existing id, so the title and owner are looked up as
 * the administrator; a failure to look them up still names the id.
 */
async function describeDuplicateBook(
  page: Page,
  existingBookId: string | null,
): Promise<string> {
  const id = existingBookId ?? 'unknown';
  if (!existingBookId) {
    return (
      `E2E fixture upload was rejected as a duplicate: an existing book ` +
      'already has this sha256. Soft-delete it through the admin API and rerun.'
    );
  }
  try {
    const headers = await adminAuth(page.request);
    const response = await page.request.get(`/api/books/${existingBookId}`, { headers });
    if (response.ok()) {
      const { book } = (await response.json()) as {
        book: { title: string; uploadedBy: { displayName: string } };
      };
      return (
        `E2E fixture upload was rejected as a duplicate: "${book.title}" (${id}) ` +
        `owned by ${book.uploadedBy.displayName} already has this sha256. ` +
        'Soft-delete that book through the admin API and rerun.'
      );
    }
  } catch {
    // Fall through to the id-only message below.
  }
  return (
    `E2E fixture upload was rejected as a duplicate: existing book ${id} ` +
    'already has this sha256. Soft-delete it through the admin API and rerun.'
  );
}

/**
 * Uploads a fixture through the shelf dialog and renames the resulting card.
 * The metadata job may rename the filename title to the embedded one, so the
 * card is located by the fixture's "reader" stem rather than by position.
 *
 * A library-wide sha256 dedupe blocks the upload when a demo copy is still on
 * the shelf; that rejection is surfaced with the existing book's id and owner
 * instead of the opaque "上传完成" timeout.
 */
export async function uploadAndRename(
  page: Page,
  fixture: string,
  title: string,
): Promise<void> {
  const duplicateChecks: Array<Promise<string | null>> = [];
  const onResponse = (response: Response): void => {
    if (!response.url().includes('/api/uploads') || response.status() !== 409) return;
    duplicateChecks.push(
      (async () => {
        const body = (await response.json().catch(() => null)) as DuplicateBookBody | null;
        if (body?.error?.code !== 'DUPLICATE_BOOK') return null;
        return describeDuplicateBook(page, body.error.details?.existingBookId ?? null);
      })(),
    );
  };
  page.on('response', onResponse);

  try {
    await page.getByRole('button', { name: '上传图书' }).click();
    await page.setInputFiles('input[type=file]', fixture);
    try {
      await expect(page.getByText('上传完成')).toBeVisible({ timeout: 90_000 });
    } catch (error) {
      const messages = (await Promise.all(duplicateChecks)).filter(
        (message): message is string => message !== null,
      );
      if (messages[0]) throw new Error(messages[0]);
      throw error;
    }
  } finally {
    page.off('response', onResponse);
  }

  const card = page.getByTestId('book-card').filter({ hasText: /reader/i }).first();
  await expect(card, 'uploaded card before it is renamed').toBeVisible();
  await card.getByRole('button', { name: /编辑《/ }).click();
  await page.getByLabel('书名').fill(title);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: /编辑《/ })).toBeHidden();
}

export async function openBook(page: Page, title: string): Promise<string> {
  await page.getByRole('link', { name: `阅读《${title}》` }).click();
  await expect(page).toHaveURL(READER_URL);
  const match = new URL(page.url()).pathname.match(/^\/books\/([^/]+)\/read$/);
  if (!match?.[1]) throw new Error(`reader URL has no book id: ${page.url()}`);
  return match[1];
}

/** Signs in as the freshly registered reader to inspect the server-side state. */
export async function readerAuth(
  request: APIRequestContext,
  username: string,
  password: string = READER_PASSWORD,
): Promise<AuthHeaders> {
  const login = await request.post('/api/auth/login', {
    data: { username, password },
  });
  expect(login.status(), 'reader login for progress check').toBe(200);
  const { accessToken } = (await login.json()) as { accessToken: string };
  return { authorization: `Bearer ${accessToken}` };
}

interface CreateReflowUploadResponse {
  uploadId: string;
  upload: { url: string; fields: Record<string, string> };
}

/**
 * Uploads a `.bookr.json` pack through the real three-step API: record the
 * session with the pack's size and the source hash it declares, POST the bytes
 * to the presigned form (fields first, file last), then flip the session to
 * complete.
 *
 * `authorization` must belong to the book's uploader (or an administrator).
 * Returns the complete response body (`{ book, pack }`).
 */
export async function uploadReflowPack(
  request: APIRequestContext,
  bookId: string,
  packPath: string,
  authorization: string,
): Promise<unknown> {
  const buffer = await readFile(packPath);
  // The create call declares the hash of the original book file, which the
  // server compares to its stored sha256; it is not the hash of the pack.
  const pack = JSON.parse(buffer.toString('utf8')) as { source?: { sha256?: string } };
  const sha256 = pack.source?.sha256;
  if (typeof sha256 !== 'string') throw new Error(`pack has no source.sha256: ${packPath}`);

  const create = await request.post(`/api/books/${bookId}/reflow/uploads`, {
    headers: { authorization },
    data: { size: buffer.byteLength, sha256 },
  });
  expect(create.status(), 'create reflow upload session').toBe(201);
  const session = (await create.json()) as CreateReflowUploadResponse;

  // Every presigned field must be part of the multipart policy; the file part
  // has to come last, which object insertion order guarantees here.
  const stored = await request.post(session.upload.url, {
    multipart: {
      ...session.upload.fields,
      file: {
        name: basename(packPath),
        mimeType: 'application/json',
        buffer,
      },
    },
  });
  expect(stored.ok(), `upload pack bytes to storage (HTTP ${stored.status()})`).toBe(true);

  const complete = await request.post(
    `/api/books/${bookId}/reflow/uploads/${session.uploadId}/complete`,
    { headers: { authorization } },
  );
  expect(complete.status(), 'complete reflow upload').toBe(200);
  return complete.json();
}

/** Drops any live DOM selection so a center tap is read as a tap, not a select. */
export async function clearSelections(page: Page): Promise<void> {
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
export async function revealChrome(page: Page): Promise<void> {
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

/**
 * Resolves once a pdf.js text-layer span contains `needle`. The layer renders
 * separately from the canvas, so the canvas being painted does not yet mean
 * text can be selected.
 */
export async function waitForPdfSpan(page: Page, needle: string): Promise<void> {
  await page.waitForFunction(
    (text) =>
      [...document.querySelectorAll('.bookr-text-layer span')].some((node) =>
        node.textContent?.includes(text),
      ),
    needle,
  );
}

/** Resolves once the first page canvas and its selectable text are rendered. */
export async function waitForPdfReady(
  page: Page,
  needle: string = 'quick brown fox',
): Promise<void> {
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({
    timeout: 15_000,
  });
  await waitForPdfSpan(page, needle);
}

/** Selects the pdf.js text-layer span containing `needle`. */
export async function selectPdfText(page: Page, needle: string): Promise<void> {
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
