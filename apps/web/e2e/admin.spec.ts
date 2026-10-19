import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import { adminAuth, loginAs } from './helpers';

const adminUsername = process.env.E2E_ADMIN_USERNAME ?? 'admin';
const adminPassword = process.env.E2E_ADMIN_PASSWORD ?? 'Admin-Test-Password-123';

/** Signs the administrator in through the real login form. */
async function signInAsAdmin(page: Page): Promise<void> {
  await loginAs(page, adminUsername, adminPassword);
}

/**
 * `backupHeartbeatSchema` requires an ISO timestamp that carries an explicit
 * offset; `toISOString()` ends in `Z`, so this rewrites it to `+00:00`.
 */
function isoWithOffset(date: Date): string {
  return date.toISOString().replace(/Z$/, '+00:00');
}

/**
 * Registration must be left open even when an assertion fails: the other
 * specs mint invites and register fresh readers.
 */
async function restoreRegistration(page: Page): Promise<void> {
  await page.goto('/admin/settings');
  const registration = page.getByLabel('允许新成员注册');
  await expect(registration).toBeVisible();
  if (await registration.isChecked()) return;

  await registration.check();
  await page.getByRole('button', { name: '保存设置' }).click();
  await expect(page.getByText('设置已保存')).toBeVisible();
}

test('disables registration, persists it and records the change in the audit log', async ({
  page,
}) => {
  await signInAsAdmin(page);

  try {
    await page.goto('/admin/settings');
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();

    const registration = page.getByLabel('允许新成员注册');
    await expect(registration).toBeVisible();
    // An interrupted earlier run may have left the switch off; always drive it
    // to the disabled state rather than assuming the default.
    if (await registration.isChecked()) {
      await registration.uncheck();
    }

    await page.getByRole('button', { name: '保存设置' }).click();
    await expect(page.getByText('设置已保存')).toBeVisible();

    await page.reload();
    await expect(page.getByRole('heading', { name: '系统设置' })).toBeVisible();
    await expect(page.getByLabel('允许新成员注册')).not.toBeChecked();

    await page.goto('/admin/audit');
    await expect(page.getByRole('heading', { name: '审计日志' })).toBeVisible();
    // The audit ledger is newest first; the save above is the latest entry.
    await expect(page.locator('tbody tr').first()).toContainText('修改系统设置');
  } finally {
    await restoreRegistration(page);
  }
});

test('shows server export and backup PC heartbeats on the backup status page', async ({
  page,
  request,
}) => {
  const headers = await adminAuth(request);

  const successFinished = new Date();
  const successStarted = new Date(successFinished.getTime() - 60_000);
  const success = await request.post('/api/admin/backup/heartbeat', {
    headers,
    data: {
      source: 'server-export',
      status: 'success',
      startedAt: isoWithOffset(successStarted),
      finishedAt: isoWithOffset(successFinished),
      bytes: 1_048_576,
      diskFreeBytes: 42 * 1024 ** 3,
      diskTotalBytes: 100 * 1024 ** 3,
      message: 'E2E server export',
    },
  });
  expect(success.status(), 'record a successful server export heartbeat').toBe(201);

  await signInAsAdmin(page);
  await page.goto('/admin/backups');
  await expect(page.getByRole('heading', { name: '备份与告警' })).toBeVisible();

  const lastSuccessCard = page.getByText('最近成功备份', { exact: true }).locator('..');
  await expect(lastSuccessCard).not.toContainText('尚无记录');
  // The card renders a formatted date and time, e.g. "10/19 17:32".
  await expect(lastSuccessCard).toContainText(/\d{1,2}:\d{2}/);

  const successRow = page
    .locator('tbody tr')
    .filter({ hasText: '服务器导出' })
    .filter({ hasText: '成功' });
  await expect(successRow.first()).toBeVisible();

  const failureFinished = new Date();
  const failureStarted = new Date(failureFinished.getTime() - 30_000);
  const failure = await request.post('/api/admin/backup/heartbeat', {
    headers,
    data: {
      source: 'backup-pc',
      status: 'failure',
      startedAt: isoWithOffset(failureStarted),
      finishedAt: isoWithOffset(failureFinished),
      message: 'E2E backup PC failure',
    },
  });
  expect(failure.status(), 'record a failed backup PC heartbeat').toBe(201);

  await page.getByRole('button', { name: '刷新' }).click();
  const failureRow = page
    .locator('tbody tr')
    .filter({ hasText: '备份机' })
    .filter({ hasText: '失败' });
  await expect(failureRow.first()).toBeVisible();
  await expect(failureRow.first()).toContainText('E2E backup PC failure');
});
