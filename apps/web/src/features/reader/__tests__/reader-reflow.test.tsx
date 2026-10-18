import { fireEvent, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { expect, it, vi } from 'vitest';
import { createMemoryRouter, RouterProvider } from 'react-router';
import { http, HttpResponse } from 'msw';
import { DEFAULT_READER_SETTINGS } from '@bookr/reader-core';
import type {
  OpenReaderOptions,
  PdfReadingMode,
  ReaderEngine,
  ReaderEngineKind,
  ReaderSettings,
} from '@bookr/reader-core';
import type { Locator } from '@bookr/shared';
import { ReaderPage } from '../ReaderPage';
import { READER_SETTINGS_KEY, saveReaderSettings } from '../readerSettings';
import { setTokens } from '../../../api/client';
import { book, renderWithProviders, server } from '../../../../test/setup';
import { createFakeEngine } from './fake-engine';
import type { FakeReaderEngine } from './fake-engine';

const BOOK_ID = 'book-csapp';
const PDF_URL = 'https://fake-s3.local/book.pdf';
const NEW_PDF_URL = 'https://fake-s3.local/book-v2.pdf';
const REFLOW_URL = 'https://fake-s3.local/book.bookr.json';
const NEW_REFLOW_URL = 'https://fake-s3.local/book-v2.bookr.json';
const PAGE_COUNT = 300;

function reflowBook(overrides: { reflowAvailable?: boolean } = {}) {
  return book({
    id: BOOK_ID,
    title: '深入理解计算机系统',
    author: 'Randal E. Bryant',
    format: 'pdf',
    reflowAvailable: overrides.reflowAvailable ?? true,
    reflowSchemaVersion: overrides.reflowAvailable === false ? null : 1,
    reflowPageCount: overrides.reflowAvailable === false ? null : PAGE_COUNT,
    uploadedBy: { id: 'user-reader', displayName: '读者' },
  });
}

function settingsFor(readingMode: PdfReadingMode): ReaderSettings {
  return {
    ...DEFAULT_READER_SETTINGS,
    pdf: { ...DEFAULT_READER_SETTINGS.pdf, readingMode },
  };
}

function storedReadingMode(): unknown {
  const stored = JSON.parse(localStorage.getItem(READER_SETTINGS_KEY) ?? 'null') as
    | { pdf?: { readingMode?: unknown } }
    | null;
  return stored?.pdf?.readingMode;
}

interface OpenCall {
  kind: ReaderEngineKind;
  url: string;
  options: OpenReaderOptions | undefined;
}

/**
 * Records every factory call and every `open`, one fake per engine kind.
 * The reflow fake relocates to page 98 after opening while its current locator
 * starts on page 120, so switching back proves the captured reflow position is
 * mapped to PDF, not the original PDF position.
 */
function recordingFactory({ failReflowOpen = false }: { failReflowOpen?: boolean } = {}) {
  const openCalls: OpenCall[] = [];
  const engines: FakeReaderEngine[] = [];
  const factory = vi.fn((kind: ReaderEngineKind) => {
    const engine = createFakeEngine(kind);
    let locator: Locator =
      kind === 'reflow'
        ? { kind: 'reflow', sourcePage: 120, percent: 0.4 }
        : { kind: 'pdf', page: 120, percent: 0.4 };
    engine.currentLocator.mockImplementation(() => locator);
    engine.open.mockImplementation(async (url, _container, _settings, options) => {
      openCalls.push({ kind, url, options });
      if (kind === 'reflow') {
        if (failReflowOpen) throw new Error('pack failed');
        locator = { kind: 'reflow', sourcePage: 98, percent: 0.33 };
        engine.emit('relocated', { locator, percent: 0.33 });
      }
      return { kind, title: '测试书', pageCount: PAGE_COUNT, toc: [] };
    });
    engines.push(engine);
    return engine as unknown as ReaderEngine;
  });
  return { factory, openCalls, engines };
}

interface RenderOptions {
  reflowAvailable?: boolean;
  reflowFetchFails?: boolean;
  failReflowOpen?: boolean;
  progress?: unknown;
  settings?: ReaderSettings;
}

async function renderReader({
  reflowAvailable = true,
  reflowFetchFails = false,
  failReflowOpen = false,
  progress = null,
  settings,
}: RenderOptions = {}) {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  if (settings) saveReaderSettings(settings);

  server.use(
    http.get('/api/books/:id', () =>
      HttpResponse.json({ book: reflowBook({ reflowAvailable }) }),
    ),
    http.get('/api/books/:id/file', () =>
      HttpResponse.json({ url: PDF_URL, format: 'pdf', expiresIn: 3600 }),
    ),
    http.get('/api/books/:id/progress', () => HttpResponse.json({ progress })),
  );
  if (reflowAvailable) {
    server.use(
      http.get('/api/books/:id/reflow', () =>
        reflowFetchFails
          ? HttpResponse.json(
              { error: { code: 'INTERNAL', message: 'pack is down' } },
              { status: 500 },
            )
          : HttpResponse.json({
              url: REFLOW_URL,
              schemaVersion: 1,
              pageCount: PAGE_COUNT,
              expiresIn: 3600,
            }),
      ),
    );
  }

  const recorder = recordingFactory({ failReflowOpen });
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={recorder.factory} /> }],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  const view = renderWithProviders(<RouterProvider router={router} />);
  return { ...recorder, view };
}

function pdfProgress(page: number) {
  return {
    bookId: BOOK_ID,
    locator: { kind: 'pdf', page, percent: 0.4 },
    percent: 0.4,
    updatedAt: new Date().toISOString(),
  };
}

it('switches to reflow at the same source page and back to the relocated page', async () => {
  const { openCalls } = await renderReader({ progress: pdfProgress(120) });

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({
      kind: 'pdf',
      url: PDF_URL,
      options: { initialLocator: { kind: 'pdf', page: 120 } },
    }),
  );

  await userEvent.click(await screen.findByRole('button', { name: '重排' }));

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({
      kind: 'reflow',
      url: REFLOW_URL,
      options: { sourcePdfUrl: PDF_URL, initialLocator: { kind: 'pdf', page: 120 } },
    }),
  );

  // The reflow engine relocated to page 98, so switching back must map that
  // reflow locator to the PDF source page rather than reusing page 120.
  await waitFor(() => expect(screen.getByText(/第 98 \/ 300 页/)).toBeInTheDocument());
  await userEvent.click(await screen.findByRole('button', { name: '原版' }));

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({
      kind: 'pdf',
      url: PDF_URL,
      options: { initialLocator: { kind: 'pdf', page: 98 } },
    }),
  );
});

it('disables the mode button when no pack exists', async () => {
  await renderReader({ reflowAvailable: false });

  const toggle = await screen.findByRole('button', { name: '重排' });
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('title', '尚未上传重排包');
});

it('offers a retry when the pack URL fetch failed and switches after a retry', async () => {
  const { openCalls } = await renderReader({ reflowFetchFails: true });

  const toggle = await screen.findByRole('button', { name: '重排' });
  expect(toggle).toBeEnabled();
  expect(toggle).toHaveAttribute('title', '重排包地址获取失败，点击重试');

  // The next attempt succeeds; the click must re-sign instead of reusing the
  // failed initial fetch.
  server.use(
    http.get('/api/books/:id/reflow', () =>
      HttpResponse.json({
        url: NEW_REFLOW_URL,
        schemaVersion: 1,
        pageCount: PAGE_COUNT,
        expiresIn: 3600,
      }),
    ),
  );

  await userEvent.click(toggle);

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({ kind: 'reflow', url: NEW_REFLOW_URL }),
  );
  expect(await screen.findByRole('button', { name: '原版' })).toBeInTheDocument();
});

it('re-signs both URLs on switch and opens the fresh ones', async () => {
  const { openCalls } = await renderReader({ progress: pdfProgress(120) });
  await waitFor(() => expect(openCalls.at(-1)?.kind).toBe('pdf'));

  let refreshes = 0;
  server.use(
    http.get('/api/books/:id/reflow', () => {
      refreshes += 1;
      return HttpResponse.json({
        url: NEW_REFLOW_URL,
        schemaVersion: 1,
        pageCount: PAGE_COUNT,
        expiresIn: 3600,
      });
    }),
    http.get('/api/books/:id/file', () => {
      refreshes += 1;
      return HttpResponse.json({ url: NEW_PDF_URL, format: 'pdf', expiresIn: 3600 });
    }),
  );

  await userEvent.click(await screen.findByRole('button', { name: '重排' }));
  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({ kind: 'reflow', url: NEW_REFLOW_URL }),
  );

  await userEvent.click(await screen.findByRole('button', { name: '原版' }));
  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({ kind: 'pdf', url: NEW_PDF_URL }),
  );
  expect(refreshes).toBe(2);
});

it('keeps the current mode when the reflow URL refresh fails', async () => {
  const { openCalls } = await renderReader({
    settings: settingsFor('original'),
    progress: pdfProgress(120),
  });
  await waitFor(() => expect(openCalls.at(-1)?.kind).toBe('pdf'));

  server.use(
    http.get('/api/books/:id/reflow', () =>
      HttpResponse.json(
        { error: { code: 'INTERNAL', message: 'pack is down' } },
        { status: 500 },
      ),
    ),
  );

  await userEvent.click(await screen.findByRole('button', { name: '重排' }));

  expect(await screen.findByText('无法获取重排包，请稍后重试')).toBeInTheDocument();
  expect(screen.getByRole('button', { name: '重排' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '原版' })).toBeNull();
  expect(openCalls.every((call) => call.kind === 'pdf')).toBe(true);
  expect(storedReadingMode()).toBe('original');
});

it('maps stored reflow progress to a PDF page when opening in original mode', async () => {
  const { openCalls } = await renderReader({
    progress: {
      bookId: BOOK_ID,
      locator: { kind: 'reflow', sourcePage: 120, percent: 0.4 },
      percent: 0.4,
      updatedAt: new Date().toISOString(),
    },
  });

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({
      kind: 'pdf',
      url: PDF_URL,
      options: { initialLocator: { kind: 'pdf', page: 120 } },
    }),
  );
});

it('applies reflow typography without reopening the book', async () => {
  const { factory, engines } = await renderReader({ settings: settingsFor('reflow') });

  await waitFor(() => expect(factory).toHaveBeenCalledWith('reflow'));
  await userEvent.click(await screen.findByRole('button', { name: '设置' }));

  fireEvent.change(screen.getByLabelText('字号'), { target: { value: '24' } });

  const reflowEngine = engines[0];
  expect(reflowEngine?.setSettings).toHaveBeenLastCalledWith(
    expect.objectContaining({ reflow: expect.objectContaining({ fontSize: 24 }) }),
  );
  expect(factory).toHaveBeenCalledTimes(1);
});

it('jumps by source page in reflow mode', async () => {
  const { openCalls, engines } = await renderReader({ settings: settingsFor('reflow') });

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({ kind: 'reflow', url: REFLOW_URL }),
  );

  const pageInput = await screen.findByLabelText('页码');
  await userEvent.clear(pageInput);
  await userEvent.type(pageInput, '60{Enter}');

  expect(engines[0]?.goTo).toHaveBeenLastCalledWith({
    kind: 'reflow',
    sourcePage: 60,
    percent: 59 / PAGE_COUNT,
  });
});

it('persists the reflow mode and honors it on remount', async () => {
  const first = await renderReader({ progress: pdfProgress(120) });
  await waitFor(() => expect(first.openCalls.at(-1)?.kind).toBe('pdf'));

  await userEvent.click(await screen.findByRole('button', { name: '重排' }));
  await waitFor(() =>
    expect(first.openCalls.at(-1)).toMatchObject({ kind: 'reflow', url: REFLOW_URL }),
  );
  expect(storedReadingMode()).toBe('reflow');

  first.view.unmount();
  const second = await renderReader();
  await waitFor(() =>
    expect(second.openCalls.at(-1)).toMatchObject({ kind: 'reflow', url: REFLOW_URL }),
  );
  expect(second.factory).toHaveBeenCalledWith('reflow');
  expect(screen.getByRole('button', { name: '原版' })).toBeInTheDocument();
});

it('never shows the mode toggle for an EPUB', async () => {
  setTokens({ accessToken: 'a', refreshToken: 'r', expiresIn: 900 });
  const engine = createFakeEngine('epub');
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={() => engine} /> }],
    { initialEntries: ['/books/book-three-body/read'] },
  );
  renderWithProviders(<RouterProvider router={router} />);

  await waitFor(() => expect(engine.open).toHaveBeenCalled());
  expect(await screen.findByRole('button', { name: '目录' })).toBeInTheDocument();
  expect(screen.queryByRole('button', { name: '重排' })).toBeNull();
  expect(screen.queryByRole('button', { name: '原版' })).toBeNull();
});

it('falls back to the original when the reflow open fails', async () => {
  const { openCalls } = await renderReader({
    settings: settingsFor('reflow'),
    progress: pdfProgress(120),
    failReflowOpen: true,
  });

  // The first reflow attempt fails, then the PDF engine opens the same source
  // page; the reader never shows the fatal error screen.
  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({
      kind: 'pdf',
      url: PDF_URL,
      options: { initialLocator: { kind: 'pdf', page: 120 } },
    }),
  );
  expect(openCalls.some((call) => call.kind === 'reflow')).toBe(true);
  expect(await screen.findByText('无法加载重排包，已切回原版')).toBeInTheDocument();
  expect(screen.queryByRole('alert')).toBeNull();
  expect(storedReadingMode()).toBe('original');
  expect(await screen.findByRole('button', { name: '重排' })).toBeInTheDocument();
});
