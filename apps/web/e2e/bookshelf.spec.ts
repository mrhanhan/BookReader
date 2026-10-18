import { expect, test } from '@playwright/test';

const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';

const READER_PASSWORD = 'e2e-reader-password';
const READER_DISPLAY_NAME = '端到端读者';
const BOOK_TITLE = '端到端测试书';

/**
 * The deployed stack is the acceptance surface: an invite-minted reader
 * registers, uploads the fixture, edits it, filters the shelf, deletes it,
 * restores it from the trash, then deletes it again so the next run can upload
 * the same sha256 (dedupe only considers live books).
 */
test('invite, register, upload, edit, filter, delete and restore', async ({ page, request }) => {
  // A fresh identity per attempt keeps repeated runs independent.
  const username = `e2e_reader_${Date.now()}`;

  // Mint the invite through the API; the admin UI is exercised elsewhere.
  const loginResponse = await request.post('/api/auth/login', {
    data: { username: adminUsername, password: adminPassword },
  });
  expect(loginResponse.status(), 'admin login for invite minting').toBe(200);
  const { accessToken } = (await loginResponse.json()) as { accessToken: string };
  const adminAuth = { authorization: `Bearer ${accessToken}` };

  // sha256 dedupe spans the whole library. An interrupted earlier attempt can
  // leave a live E2E book behind, which would block this run's upload, so move
  // those leftovers to the trash first.
  const shelfResponse = await request.get('/api/books?pageSize=100', { headers: adminAuth });
  expect(shelfResponse.status(), 'list shelf for cleanup').toBe(200);
  const shelf = (await shelfResponse.json()) as {
    items: Array<{ id: string; uploadedBy: { displayName: string } }>;
  };
  for (const leftover of shelf.items) {
    if (leftover.uploadedBy.displayName !== READER_DISPLAY_NAME) continue;
    const cleaned = await request.delete(`/api/books/${leftover.id}`, { headers: adminAuth });
    expect(cleaned.status(), 'trash leftover E2E book').toBe(204);
  }

  const inviteResponse = await request.post('/api/admin/invites', {
    headers: adminAuth,
    data: { expiresInHours: 1 },
  });
  expect(inviteResponse.status(), 'create invite').toBe(201);
  const { code } = (await inviteResponse.json()) as { code: string };

  await page.goto('/register');
  await page.getByLabel('邀请码').fill(code);
  await page.getByLabel('用户名').fill(username);
  await page.getByLabel('显示名称').fill(READER_DISPLAY_NAME);
  await page.getByLabel('密码').fill(READER_PASSWORD);
  await page.getByRole('button', { name: '注册' }).click();
  await expect(page).toHaveURL('/');
  await expect(page.getByRole('button', { name: '上传图书' })).toBeVisible();

  await page.getByRole('button', { name: '上传图书' }).click();
  await page.setInputFiles('input[type=file]', 'e2e/fixtures/sample.pdf');
  await expect(page.getByText('上传完成')).toBeVisible({ timeout: 60_000 });

  const cards = page.getByTestId('book-card');
  await expect(cards.first()).toBeVisible();

  // The metadata job may rename the book to its embedded title, so the action
  // buttons are addressed by their prefix rather than by the current title.
  await cards.first().getByRole('button', { name: /编辑《/ }).click();
  await page.getByLabel('书名').fill(BOOK_TITLE);
  await page.getByRole('button', { name: '保存' }).click();
  await expect(page.getByRole('heading', { name: /编辑《/ })).toBeHidden();

  const bookCard = cards.filter({ hasText: BOOK_TITLE });
  await expect(bookCard).toBeVisible();

  await page.getByLabel('格式').selectOption('pdf');
  await expect(bookCard).toBeVisible();
  await page.getByLabel('格式').selectOption('epub');
  await expect(bookCard).toHaveCount(0);
  await page.getByLabel('格式').selectOption('');

  await bookCard.getByRole('button', { name: /删除《/ }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('已移入回收站')).toBeVisible();
  await expect(bookCard).toHaveCount(0);

  await page.goto('/trash');
  // Earlier runs leave their own books in the trash; only the current reader's
  // entry has a restore button, which makes it unambiguous.
  const trashItem = page
    .getByTestId('trash-item')
    .filter({ hasText: BOOK_TITLE })
    .filter({ has: page.getByRole('button', { name: /恢复《/ }) });
  await expect(trashItem).toHaveCount(1);
  await trashItem.getByRole('button', { name: /恢复《/ }).click();
  await expect(page.getByText('已恢复到书架')).toBeVisible();

  await page.goto('/');
  await expect(bookCard).toBeVisible();

  // Leave the book in the trash: the next run re-uploads the same file, and
  // sha256 dedupe ignores soft-deleted rows.
  await bookCard.getByRole('button', { name: /删除《/ }).click();
  await page.getByRole('button', { name: '确认删除' }).click();
  await expect(page.getByText('已移入回收站')).toBeVisible();
  await expect(bookCard).toHaveCount(0);
});
