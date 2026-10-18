import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  READER_PASSWORD,
  adminAuth,
  deleteE2EBooks,
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
 * Acceptance for the AI companion. Every test registers its own reader and
 * uploads the fixture, then `afterEach` soft-deletes the book again: the suite
 * shares one real library and its sha256 dedupe spans the whole shelf.
 */
test.afterEach(async ({ request }) => {
  await deleteE2EBooks(request);
});

const TITLE = '端到端 AI 伴读';
const FIXTURE = 'e2e/fixtures/reader.pdf';
const PHRASE = 'quick brown fox';
const FAKE_REPLY = '已收到上下文';
const FOLLOW_UP = '再展开一点';

/**
 * The fake provider is deterministic, so the acceptance run needs the stack to
 * be built with `AI_FAKE_PROVIDER=1`. Without it a real provider would be
 * called (or none configured) and every assertion below would fail for an
 * environment reason; fail loudly and early instead.
 */
test.beforeAll(async ({ request }) => {
  const headers = await adminAuth(request);
  const usage = await request.get('/api/ai/usage', { headers });
  expect(usage.status()).toBe(200);
  expect(
    (await usage.json()).fakeProvider,
    'E2E requires AI_FAKE_PROVIDER=1 on the disposable stack (see README)',
  ).toBe(true);
});

async function openAiPanel(page: Page): Promise<void> {
  await revealChrome(page);
  await page.getByRole('button', { name: 'AI' }).click();
  await expect(page.getByRole('complementary', { name: 'AI 伴读' })).toBeVisible();
}

async function expectFakeReply(page: Page): Promise<void> {
  await expect(page.getByText(FAKE_REPLY, { exact: false }).last()).toBeVisible({
    timeout: 20_000,
  });
}

/**
 * Both the reply text and the persisted thread count are checked: waiting on
 * the finished assistant bubble makes the follow-up deterministic, because the
 * composer refuses to send while the previous answer is still streaming.
 */
async function expectAssistantMessages(page: Page, count: number): Promise<void> {
  await expect(
    page.locator('.ai-message-assistant[data-status="complete"] .ai-assistant-text'),
  ).toHaveCount(count, { timeout: 20_000 });
}

interface ThreadListBody {
  items: Array<{ messageCount: number }>;
}

async function threadCount(
  request: APIRequestContext,
  headers: AuthHeaders,
  bookId: string,
): Promise<ThreadListBody> {
  const response = await request.get(`/api/books/${bookId}/ai/threads`, { headers });
  expect(response.status()).toBe(200);
  return (await response.json()) as ThreadListBody;
}

test('explains a selection and keeps the thread for follow-ups', async ({
  page,
  request,
}) => {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);
  await selectPdfText(page, PHRASE);

  // Explain opens the panel by itself; the explicit assertion documents that.
  await page.getByRole('button', { name: '解释' }).click();
  await expect(page.getByRole('complementary', { name: 'AI 伴读' })).toBeVisible();
  await expectAssistantMessages(page, 1);
  await expectFakeReply(page);

  const headers = await readerAuth(request, reader.username, READER_PASSWORD);
  // One exchange is one user message plus one assistant reply.
  await expect
    .poll(async () => (await threadCount(request, headers, bookId)).items[0]?.messageCount, {
      timeout: 15_000,
    })
    .toBe(2);

  // The follow-up joins the same thread instead of starting a new one.
  await page.getByLabel('向 AI 提问').fill(FOLLOW_UP);
  await page.getByLabel('向 AI 提问').press('Enter');
  await expectAssistantMessages(page, 2);
  await expectFakeReply(page);
  await expect
    .poll(async () => (await threadCount(request, headers, bookId)).items[0]?.messageCount, {
      timeout: 20_000,
    })
    .toBe(4);
  expect((await threadCount(request, headers, bookId)).items).toHaveLength(1);
});

test('summarizes the current page', async ({ page, request }) => {
  await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);
  await openAiPanel(page);

  await page.getByRole('button', { name: '总结本页' }).click();
  await expectAssistantMessages(page, 1);
  await expect(
    page.locator('.ai-action-label').filter({ hasText: '总结' }),
    '总结请求带着标签出现在对话里',
  ).toBeVisible();
  await expectFakeReply(page);
});

test('marks AI unavailable while offline', async ({ page, request, context }) => {
  await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);
  await openAiPanel(page);

  await context.setOffline(true);
  try {
    await expect(page.getByText('离线时 AI 不可用，联网后自动恢复')).toBeVisible();
  } finally {
    await context.setOffline(false);
  }
});

test('honours the settings toggle', async ({ page, request }) => {
  await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await openBook(page, TITLE);
  await waitForPdfReady(page, PHRASE);

  await page.goto('/settings');
  const section = page.getByRole('region', { name: 'AI 伴读' });
  const toggle = section.getByRole('checkbox', { name: '启用 AI 伴读' });
  await toggle.uncheck();
  await expect(toggle).not.toBeChecked();

  await page.goto(`/books/${bookId}/read`);
  await waitForPdfReady(page, PHRASE);
  await openAiPanel(page);
  await expect(page.getByText('AI 伴读已在设置中关闭')).toBeVisible();
});
