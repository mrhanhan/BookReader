import { readFile } from 'node:fs/promises';
import { basename } from 'node:path';
import { expect } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';

const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';

export const READER_PASSWORD = 'e2e-reader-password';
const READER_DISPLAY_NAME = '阅读端到端';
const READER_URL = /\/books\/[^/]+\/read$/;

export interface FreshReader {
  username: string;
}

export interface AuthHeaders {
  authorization: string;
}

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
export async function uploadAndRename(
  page: Page,
  fixture: string,
  title: string,
): Promise<void> {
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
