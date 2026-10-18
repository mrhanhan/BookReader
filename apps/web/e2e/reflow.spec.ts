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
    blockId?: string;
    charRange?: [number, number];
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
  await expect(page.locator('.bookr-reflow')).toBeVisible();
  await expect(
    page.getByText('Bookr reader fixture - page 1', { exact: true }),
  ).toBeInViewport();

  // Jump to source page 120 in reflow mode; the label tracks the target page.
  await revealChrome(page);
  await page.getByLabel('页码').fill('120');
  await page.getByRole('button', { name: '跳转' }).click();
  await expect(page.getByText('第 120 / 300 页')).toBeVisible();
  await expect(
    page.getByText('Bookr reader fixture - page 120', { exact: true }),
  ).toBeInViewport();

  // Typography applies without reopening or moving the reader off page 120.
  await revealChrome(page);
  await page.getByRole('button', { name: '设置' }).click();
  await setFontSize(page, 24);
  await expect(page.locator('.bookr-reflow')).toHaveCSS('font-size', '24px');
  await expect(page.getByText('第 120 / 300 页')).toBeVisible();
  await page
    .getByRole('complementary', { name: '阅读设置' })
    .getByRole('button', { name: '关闭' })
    .click();

  // Switch back: the original PDF lands within one source page of 120.
  await revealChrome(page);
  await page.getByRole('button', { name: '原版' }).click();
  await expect(page.locator('.bookr-pdf-page canvas').first()).toBeVisible({ timeout: 15_000 });
  await revealChrome(page);
  await expect(page.getByText(/第 1(?:19|20|21) \/ 300 页/)).toBeVisible();

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
  const locator = body.items[0]?.locator;
  expect(locator?.kind).toBe('reflow');
  // The selection sits in page 1's first block (the extra page-1 block only
  // shifts later indices), so the stored locator must name that block and its
  // exact character range. `ranges` stays unset for a single-block selection.
  expect(locator?.blockId).toBe('p1-b0');
  expect(locator?.charRange).toEqual([0, 12]);
});
