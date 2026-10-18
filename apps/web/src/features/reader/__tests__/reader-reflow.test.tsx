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
import { ReaderPage } from '../ReaderPage';
import { saveReaderSettings } from '../readerSettings';
import { setTokens } from '../../../api/client';
import { book, renderWithProviders, server } from '../../../../test/setup';
import { createFakeEngine } from './fake-engine';
import type { FakeReaderEngine } from './fake-engine';

const BOOK_ID = 'book-csapp';
const PDF_URL = 'https://fake-s3.local/book.pdf';
const REFLOW_URL = 'https://fake-s3.local/book.bookr.json';
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

interface OpenCall {
  kind: ReaderEngineKind;
  url: string;
  options: OpenReaderOptions | undefined;
}

/** Records every factory call and every `open`, one fake per engine kind. */
function recordingFactory() {
  const openCalls: OpenCall[] = [];
  const engines: FakeReaderEngine[] = [];
  const factory = vi.fn((kind: ReaderEngineKind) => {
    const engine = createFakeEngine(kind);
    engine.currentLocator.mockReturnValue({ kind: 'pdf', page: 120, percent: 0.4 });
    engine.open.mockImplementation(async (url, _container, _settings, options) => {
      openCalls.push({ kind, url, options });
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
  progress?: unknown;
  settings?: ReaderSettings;
}

async function renderReader({
  reflowAvailable = true,
  reflowFetchFails = false,
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

  const recorder = recordingFactory();
  const router = createMemoryRouter(
    [{ path: '/books/:id/read', element: <ReaderPage engineFactory={recorder.factory} /> }],
    { initialEntries: [`/books/${BOOK_ID}/read`] },
  );
  renderWithProviders(<RouterProvider router={router} />);
  return recorder;
}

function pdfProgress(page: number) {
  return {
    bookId: BOOK_ID,
    locator: { kind: 'pdf', page, percent: 0.4 },
    percent: 0.4,
    updatedAt: new Date().toISOString(),
  };
}

it('switches to reflow at the same source page and back to the original', async () => {
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

  await userEvent.click(await screen.findByRole('button', { name: '原版' }));

  await waitFor(() =>
    expect(openCalls.at(-1)).toMatchObject({
      kind: 'pdf',
      url: PDF_URL,
      options: { initialLocator: { kind: 'pdf', page: 120 } },
    }),
  );
});

it('disables the mode button when no pack exists', async () => {
  await renderReader({ reflowAvailable: false });

  const toggle = await screen.findByRole('button', { name: '重排' });
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('title', '尚未上传重排包');
});

it('keeps the mode button disabled when the pack URL cannot be fetched', async () => {
  await renderReader({ reflowFetchFails: true });

  const toggle = await screen.findByRole('button', { name: '重排' });
  expect(toggle).toBeDisabled();
  expect(toggle).toHaveAttribute('title', '尚未上传重排包');
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

  await waitFor(() =>
    expect(factory).toHaveBeenCalledWith('reflow'),
  );
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
