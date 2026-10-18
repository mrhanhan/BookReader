import { expect, test } from '@playwright/test';
import type { Page } from '@playwright/test';
import {
  READER_PASSWORD,
  openBook,
  readerAuth,
  registerFreshReader,
  revealChrome,
  uploadAndRename,
  uploadReflowPack,
} from './helpers';

const PDF_TITLE = '端到端重排 PDF';
const PDF_FIXTURE = 'e2e/fixtures/reader.pdf';
const REFLOW_FIXTURE = 'e2e/fixtures/reader.bookr.json';

interface ServerAnnotation {
  locator: {
    kind: string;
    sourcePage?: number;
    ranges?: Array<{ blockId: string; charRange: [number, number] }>;
  };
}

/** The reflow font-size control is an `<input type="range">`, so arrows step it. */
async function setFontSize(page: Page, size: number): Promise<void> {
  const slider = page.getByLabel('字号');
  let current = Number(await slider.inputValue());
  const key = current < size ? 'ArrowRight' : 'ArrowLeft';
  while (current !== size) {
    await slider.press(key);
    current += current < size ? 1 : -1;
  }
}

/**
 * The page-number jump maps to a percentage of the scroll range, while the
 * reader reports the block above its focus line; the two differ by a page or
 * two. Scroll in small steps until the reader itself reports `target`, so the
 * cross-mode assertion compares like with like.
 */
async function settleOnSourcePage(page: Page, target: number): Promise<void> {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await revealChrome(page);
    const label = (await page.locator('.reader-page-label').textContent()) ?? '';
    const current = Number(/第 (\d+) \//.exec(label)?.[1]);
    if (current === target) return;
    if (!Number.isFinite(current)) break;
    await page.evaluate((amount) => {
      const host = document.querySelector<HTMLElement>('.bookr-reflow-scroll');
      if (!host) throw new Error('reflow host missing');
      host.scrollTop += amount;
    }, current < target ? 40 : -40);
    await page.waitForTimeout(80);
  }
  throw new Error(`could not settle the reflow reader on source page ${target}`);
}

test('reads a PDF in reflow mode, keeps its page across modes and saves a reflow highlight', async ({
  page,
  request,
}) => {
  const { username } = await registerFreshReader(page, request);
  await uploadAndRename(page, PDF_FIXTURE, PDF_TITLE);
  const bookId = await openBook(page, PDF_TITLE);

  const auth = await readerAuth(request, username, READER_PASSWORD);
  await uploadReflowPack(request, bookId, REFLOW_FIXTURE, auth.authorization);

  // The book DTO now advertises a pack; the mode button only enables once the
  // signed pack URL has been resolved as well.
  await page.reload();
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });
  await revealChrome(page);
  await expect(page.getByRole('button', { name: '重排' })).toBeEnabled();
  await page.getByRole('button', { name: '重排' }).click();
  await expect(page.locator('.bookr-reflow')).toContainText('Bookr reader fixture - page 1');

  // Jump to source page 120 in reflow mode.
  await revealChrome(page);
  await page.getByLabel('页码').fill('120');
  await page.getByRole('button', { name: '跳转' }).click();
  await expect(page.getByText('Bookr reader fixture - page 120')).toBeInViewport();

  // Typography applies without reopening the document.
  await revealChrome(page);
  await page.getByRole('button', { name: '设置' }).click();
  await setFontSize(page, 24);
  await expect(page.locator('.bookr-reflow')).toHaveCSS('font-size', '24px');
  await page
    .getByRole('complementary', { name: '阅读设置' })
    .getByRole('button', { name: '关闭' })
    .click();

  // Larger type grows every block while the engine deliberately keeps
  // `scrollTop`, so the focus-line source page drifts a couple of pages.
  // Re-anchor to 120 before the switch so the assertion below tests mode
  // preservation rather than that expected typography drift.
  await revealChrome(page);
  await page.getByLabel('页码').fill('120');
  await page.getByRole('button', { name: '跳转' }).click();
  await expect(page.getByText('Bookr reader fixture - page 120')).toBeInViewport();
  await settleOnSourcePage(page, 120);

  // Switch back: the original PDF lands on the same source page (±1).
  await page.getByRole('button', { name: '原版' }).click();
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });
  await revealChrome(page);
  await expect(page.getByText(/第 12[01] \/ 300 页/)).toBeVisible();

  // Switch again and create a reflow highlight through the real selection menu.
  await revealChrome(page);
  await page.getByRole('button', { name: '重排' }).click();
  await expect(page.locator('.bookr-reflow')).toBeVisible({ timeout: 15_000 });
  await page.evaluate(() => {
    const block = document.querySelector<HTMLElement>('.bookr-reflow [data-block-id]');
    const text = block?.firstChild;
    if (!block || !text) throw new Error('reflow block missing');
    const range = document.createRange();
    range.setStart(text, 0);
    range.setEnd(text, Math.min(12, text.textContent?.length ?? 0));
    const selection = window.getSelection();
    selection?.removeAllRanges();
    selection?.addRange(range);
    document.dispatchEvent(new Event('selectionchange'));
  });
  await page.getByRole('button', { name: '用黄色划线' }).click();

  // The POST is asynchronous; poll until the server shows the annotation.
  await expect
    .poll(
      async () => {
        const response = await request.get(`/api/books/${bookId}/annotations`, {
          headers: auth,
        });
        if (!response.ok()) return null;
        const body = (await response.json()) as { items: ServerAnnotation[] };
        return body.items[0]?.locator ?? null;
      },
      { timeout: 15_000, message: 'reflow annotation reaches the server' },
    )
    .not.toBeNull();

  const annotations = await request.get(`/api/books/${bookId}/annotations`, {
    headers: auth,
  });
  const body = (await annotations.json()) as { items: ServerAnnotation[] };
  expect(body.items[0]?.locator.kind).toBe('reflow');
  expect(body.items[0]?.locator.ranges?.length ?? 1).toBeGreaterThanOrEqual(1);
});
