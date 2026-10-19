import { readFile } from 'node:fs/promises';
import { expect, test } from '@playwright/test';
import type { APIRequestContext, Page } from '@playwright/test';
import {
  adminAuth,
  deleteE2EBooks,
  openBook,
  readerAuth,
  registerFreshReader,
  revealChrome,
  uploadAndRename,
  waitForPdfReady,
} from './helpers';

/**
 * Acceptance for the cross-book notes library, the Markdown export and the
 * streamed AI analysis. Every test registers its own reader and uploads the
 * fixture, then `afterEach` soft-deletes the book again: the suite shares one
 * real library and its sha256 dedupe spans the whole shelf.
 */
const TITLE = '端到端笔记库';
const FIXTURE = 'e2e/fixtures/reader.pdf';
const NOTE_QUOTE = 'quick brown fox';
const NOTE_TEXT = '狐狸与狗';
const HIGHLIGHT_QUOTE = '程序由指令组成';
const TAG = '端到端';
const FAKE_REPLY = '已收到上下文';
const PDF_LOCATOR = { kind: 'pdf', page: 1, percent: 0 } as const;

/**
 * The reader whose analyses this test created. Saved analyses outlive their
 * book on purpose (they store the generated text), so they are deleted by the
 * `afterEach` below instead of piling up between runs.
 */
let analysisReader: string | null = null;

/**
 * The fake provider is deterministic, so the acceptance run needs the stack to
 * be built with `AI_FAKE_PROVIDER=1`. Without it a real provider would be
 * called (or none configured) and the analysis assertions below would fail for
 * an environment reason; fail loudly and early instead.
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

test.afterEach(async ({ request }) => {
  await deleteE2EBooks(request);
  const username = analysisReader;
  analysisReader = null;
  if (username !== null) await deleteReaderAnalyses(request, username);
});

interface CreateAnnotationPayload {
  type: 'note' | 'highlight';
  color: 'yellow' | 'green';
  locator: typeof PDF_LOCATOR;
  selectedText: string;
  noteText?: string;
  tags?: string[];
}

/** Creates an annotation through the reader API and returns its id. */
async function createNoteViaApi(
  request: APIRequestContext,
  username: string,
  bookId: string,
  data: CreateAnnotationPayload,
): Promise<string> {
  const headers = await readerAuth(request, username);
  const response = await request.post(`/api/books/${bookId}/annotations`, {
    headers,
    data,
  });
  expect(response.status(), 'create annotation via api').toBe(201);
  const { annotation } = (await response.json()) as { annotation: { id: string } };
  return annotation.id;
}

/** Best-effort cleanup: a failed registration must not mask the test error. */
async function deleteReaderAnalyses(
  request: APIRequestContext,
  username: string,
): Promise<void> {
  try {
    const headers = await readerAuth(request, username);
    const list = await request.get('/api/notes/analyses', { headers });
    if (!list.ok()) return;
    const { items } = (await list.json()) as { items: Array<{ id: string }> };
    for (const item of items) {
      await request.delete(`/api/notes/analyses/${item.id}`, { headers });
    }
  } catch {
    // The account may not exist when the test failed during registration.
  }
}

/** Opens the notes library through the main navigation. */
async function openNotesLibrary(page: Page): Promise<void> {
  await page.goto('/');
  await page
    .getByRole('navigation', { name: '主导航' })
    .getByRole('link', { name: '笔记' })
    .click();
  await expect(page).toHaveURL('/notes');
  await expect(page.getByRole('heading', { name: '笔记库' })).toBeVisible();
}

/**
 * Registers a reader, uploads the fixture, creates the two annotations the
 * library tests share and returns the book id.
 */
async function seedNotes(
  page: Page,
  request: APIRequestContext,
): Promise<{ username: string; bookId: string }> {
  const reader = await registerFreshReader(page, request);
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await openBook(page, TITLE);

  await createNoteViaApi(request, reader.username, bookId, {
    type: 'note',
    color: 'yellow',
    locator: PDF_LOCATOR,
    selectedText: NOTE_QUOTE,
    noteText: NOTE_TEXT,
    tags: [TAG],
  });
  await createNoteViaApi(request, reader.username, bookId, {
    type: 'highlight',
    color: 'green',
    locator: PDF_LOCATOR,
    selectedText: HIGHLIGHT_QUOTE,
  });

  return { username: reader.username, bookId };
}

test('searches, filters and jumps back to the source note', async ({ page, request }) => {
  await seedNotes(page, request);
  await openNotesLibrary(page);

  const cards = page.getByTestId('note-card');
  await expect(cards, 'the two seeded annotations are listed').toHaveCount(2);
  await expect(page.getByText(NOTE_TEXT, { exact: true })).toBeVisible();
  await expect(page.getByText(HIGHLIGHT_QUOTE, { exact: true })).toBeVisible();

  // Search settles after the 300 ms debounce; the expectation retries until it.
  await page.getByLabel('搜索笔记').fill('狐狸');
  await expect(cards).toHaveCount(1);
  await expect(cards.first()).toContainText(NOTE_TEXT);

  await page.getByLabel('搜索笔记').fill('');
  await expect(cards).toHaveCount(2);

  await page.getByLabel('按标签筛选').selectOption({ label: TAG });
  await expect(cards, 'only the tagged note survives the tag filter').toHaveCount(1);
  await expect(cards.first()).toContainText(NOTE_TEXT);

  await cards.first().getByRole('link', { name: '跳回原文' }).click();
  await expect(page).toHaveURL(/\/books\/[^/]+\/read\?note=/);
  await waitForPdfReady(page, NOTE_QUOTE);
  await revealChrome(page);
  await expect(page.getByText(/第 1 \/ \d+ 页/).first()).toBeVisible();

  await page.goto('/notes');
  await expect(page.getByRole('heading', { name: '笔记库' })).toBeVisible();
});

test('exports the filtered notes as markdown', async ({ page, request }) => {
  await seedNotes(page, request);
  await openNotesLibrary(page);

  await page.getByLabel('按标签筛选').selectOption({ label: TAG });
  await expect(page.getByTestId('note-card')).toHaveCount(1);
  // The server only names the file after a book when the book filter is set;
  // the tag keeps the content to the single tagged note either way.
  await page.getByLabel('按书筛选').selectOption({ label: TITLE });
  await expect(page.getByTestId('note-card')).toHaveCount(1);

  const downloadPromise = page.waitForEvent('download');
  await page.getByRole('button', { name: '导出 Markdown' }).click();
  const download = await downloadPromise;

  expect(download.suggestedFilename()).toMatch(
    /^笔记-端到端笔记库-\d{8}\.md$/,
  );
  const path = await download.path();
  expect(path, 'downloaded export has a local path').not.toBeNull();
  const markdown = await readFile(path ?? '', 'utf8');

  expect(markdown).toContain(`## 《${TITLE}》`);
  expect(markdown).toContain(`> ${NOTE_QUOTE}`);
  expect(markdown).toContain(NOTE_TEXT);
  expect(markdown).toContain(`标签：#${TAG}`);
  // The tag filter also keeps the untagged highlight out of the export.
  expect(markdown).not.toContain(HIGHLIGHT_QUOTE);
});

test('runs a note analysis and keeps it in history', async ({ page, request }) => {
  const reader = await registerFreshReader(page, request);
  analysisReader = reader.username;
  await uploadAndRename(page, FIXTURE, TITLE);
  const bookId = await openBook(page, TITLE);
  await createNoteViaApi(request, reader.username, bookId, {
    type: 'note',
    color: 'yellow',
    locator: PDF_LOCATOR,
    selectedText: NOTE_QUOTE,
    noteText: NOTE_TEXT,
    tags: [TAG],
  });
  await createNoteViaApi(request, reader.username, bookId, {
    type: 'highlight',
    color: 'green',
    locator: PDF_LOCATOR,
    selectedText: HIGHLIGHT_QUOTE,
  });

  await openNotesLibrary(page);
  await page.getByLabel('按书筛选').selectOption({ label: TITLE });
  await expect(page.getByTestId('note-card')).toHaveCount(2);

  await page.getByRole('button', { name: '分析笔记' }).click();
  const panel = page.getByRole('complementary', { name: 'AI 笔记分析' });
  await expect(panel).toBeVisible();

  await panel.getByRole('button', { name: '主题归纳' }).click();
  await panel.getByRole('button', { name: '开始分析' }).click();
  await expect(panel.getByText(FAKE_REPLY, { exact: false })).toBeVisible({
    timeout: 20_000,
  });

  // Reload only after the row settled, otherwise the list hides the streaming
  // placeholder and the history assertions below would race the stream.
  const headers = await readerAuth(request, reader.username);
  await expect
    .poll(
      async () => {
        const response = await request.get('/api/notes/analyses', { headers });
        if (!response.ok()) return `HTTP ${response.status()}`;
        const { items } = (await response.json()) as {
          items: Array<{ status: string }>;
        };
        return items[0]?.status ?? 'missing';
      },
      { timeout: 20_000, message: 'analysis row settles as complete' },
    )
    .toBe('complete');

  await page.reload();
  await page.getByRole('button', { name: '分析笔记' }).click();
  const reopened = page.getByRole('complementary', { name: 'AI 笔记分析' });
  await expect(reopened).toBeVisible();

  const recent = reopened.getByRole('region', { name: '最近分析' });
  const first = recent.getByRole('listitem').first();
  const historyTitle = `《${TITLE}》主题归纳`;
  await expect(first).toContainText(historyTitle);

  await first.getByRole('button', { name: historyTitle }).click();
  await expect(reopened.getByText(FAKE_REPLY, { exact: false })).toBeVisible({
    timeout: 20_000,
  });
});
