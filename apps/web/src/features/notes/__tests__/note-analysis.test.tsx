import { act, screen, waitFor, within } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import type { UserEvent } from '@testing-library/user-event';
import { afterEach, expect, it, vi } from 'vitest';
import { MemoryRouter } from 'react-router';
import type { NoteAnalysisDto, NoteAnalysisSummaryDto } from '@bookr/shared';
import { ApiError } from '../../../api/client';
import { renderWithProviders } from '../../../../test/setup';
import { NoteAnalysisPanel } from '../NoteAnalysisPanel';
import { NotesPage } from '../NotesPage';
import type { NoteAnalysisApi } from '../useNoteAnalysis';

afterEach(() => {
  vi.restoreAllMocks();
  act(() => {
    // The offline test installs an own property over jsdom's getter.
    Reflect.deleteProperty(navigator, 'onLine');
    window.dispatchEvent(new Event('online'));
  });
});

function makeApi(overrides: Partial<NoteAnalysisApi> = {}): NoteAnalysisApi {
  return {
    list: vi.fn(async () => [] as NoteAnalysisSummaryDto[]),
    get: vi.fn(async (id: string) => {
      throw new ApiError(404, 'NOT_FOUND', `missing analysis ${id}`);
    }),
    remove: vi.fn(async () => undefined),
    stream: vi.fn(async () => undefined),
    ...overrides,
  };
}

function renderPage(api: NoteAnalysisApi) {
  return renderWithProviders(
    <MemoryRouter initialEntries={['/notes']}>
      <NotesPage analysisApi={api} />
    </MemoryRouter>,
  );
}

async function openPanel(user: UserEvent): Promise<HTMLElement> {
  await user.click(screen.getByRole('button', { name: '分析笔记' }));
  return screen.findByRole('complementary', { name: 'AI 笔记分析' });
}

const summary: NoteAnalysisSummaryDto = {
  id: 'analysis-1',
  kind: 'themes',
  status: 'complete',
  title: '计算机系统主题',
  noteCount: 2,
  analyzedCount: 2,
  createdAt: '2026-10-01T08:30:00.000Z',
  updatedAt: '2026-10-01T08:30:00.000Z',
};

const detail: NoteAnalysisDto = {
  ...summary,
  content: '已保存的分析内容',
  model: 'test-model',
  promptVersion: 'v1',
  scope: {},
};

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((settle) => {
    resolve = settle;
  });
  return { promise, resolve };
}

it('runs an analysis and streams the answer', async () => {
  const user = userEvent.setup();
  const list = vi.fn<NoteAnalysisApi['list']>(async () => []);
  list.mockResolvedValue([summary]);
  const stream = vi.fn<NoteAnalysisApi['stream']>(async (_body, handlers) => {
    handlers.onMeta({
      analysisId: 'analysis-1',
      kind: 'themes',
      model: 'test-model',
      promptVersion: 'v1',
      noteCount: 2,
      analyzedCount: 2,
    });
    handlers.onDelta('主题一');
    handlers.onDelta('、主题二');
    handlers.onDone({
      analysisId: 'analysis-1',
      usage: { promptTokens: 10, completionTokens: 5 },
      quota: {
        daily: { used: 10, reserved: 0, limit: 100_000 },
        monthly: { used: 10, reserved: 0, limit: 1_000_000 },
      },
    });
  });

  renderPage(makeApi({ list, stream }));
  // The analysis must follow the filters active on the page.
  await user.selectOptions(screen.getByLabelText('按类型筛选'), 'note');
  await openPanel(user);

  expect(screen.getByRole('button', { name: '主题归纳' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );

  await user.click(screen.getByRole('button', { name: '开始分析' }));

  expect(await screen.findByText('主题一、主题二')).toBeInTheDocument();
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
  expect(stream).toHaveBeenCalledWith(
    expect.objectContaining({
      kind: 'themes',
      filters: expect.objectContaining({ type: 'note' }),
    }),
    expect.anything(),
    expect.objectContaining({ signal: expect.any(AbortSignal) }),
  );
});

it('shows the empty-scope error', async () => {
  const user = userEvent.setup();
  const stream = vi.fn<NoteAnalysisApi['stream']>(async () => {
    throw new ApiError(400, 'VALIDATION_FAILED', 'no notes in scope', {
      reason: 'no_notes',
    });
  });

  renderPage(makeApi({ stream }));
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '开始分析' }));

  expect(await screen.findByText('当前筛选下没有可分析的笔记')).toBeInTheDocument();
});

it('shows a stream error frame and marks the run failed', async () => {
  const user = userEvent.setup();
  const list = vi.fn<NoteAnalysisApi['list']>(async () => []);
  const stream = vi.fn<NoteAnalysisApi['stream']>(async (_body, handlers) => {
    handlers.onMeta({
      analysisId: 'analysis-1',
      kind: 'themes',
      model: 'test-model',
      promptVersion: 'v1',
      noteCount: 2,
      analyzedCount: 2,
    });
    handlers.onDelta('部分内容');
    handlers.onError({
      code: 'AI_UPSTREAM_FAILED',
      message: 'AI 服务暂时不可用，请稍后重试',
      retryable: true,
    });
  });

  renderPage(makeApi({ list, stream }));
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '开始分析' }));

  expect(await screen.findByText('AI 服务暂时不可用，请稍后重试')).toBeInTheDocument();
  // The partial text stays visible and the content area reflects the failure.
  expect(screen.getByText('部分内容')).toHaveAttribute('data-status', 'failed');
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('stops a running analysis and keeps partial text', async () => {
  const user = userEvent.setup();
  let signal: AbortSignal | undefined;
  const list = vi.fn<NoteAnalysisApi['list']>(async () => []);
  const stream = vi.fn<NoteAnalysisApi['stream']>(
    (_body, handlers, options) =>
      new Promise<void>((_resolve, reject) => {
        signal = options?.signal;
        handlers.onMeta({
          analysisId: 'analysis-1',
          kind: 'themes',
          model: 'test-model',
          promptVersion: 'v1',
          noteCount: 2,
          analyzedCount: 2,
        });
        handlers.onDelta('部分内容');
        const onAbort = () => reject(new DOMException('Aborted', 'AbortError'));
        if (options?.signal?.aborted) onAbort();
        else options?.signal?.addEventListener('abort', onAbort);
      }),
  );

  renderPage(makeApi({ list, stream }));
  await openPanel(user);
  await user.click(screen.getByRole('button', { name: '开始分析' }));
  expect(await screen.findByText('部分内容')).toBeInTheDocument();

  await user.click(screen.getByRole('button', { name: '停止' }));

  await waitFor(() => expect(signal?.aborted).toBe(true));
  expect(await screen.findByText('已停止，已生成的部分已保存')).toBeInTheDocument();
  expect(screen.getByText('部分内容')).toBeInTheDocument();
  // The server saved the interrupted row, so the history must be refreshed.
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('opens and deletes a saved analysis', async () => {
  const user = userEvent.setup();
  const list = vi.fn<NoteAnalysisApi['list']>(async () => [summary]);
  const get = vi.fn<NoteAnalysisApi['get']>(async () => detail);
  const remove = vi.fn<NoteAnalysisApi['remove']>(async () => undefined);

  renderPage(makeApi({ list, get, remove }));
  const panel = await openPanel(user);

  await user.click(within(panel).getByRole('button', { name: summary.title }));
  expect(await screen.findByText('已保存的分析内容')).toBeInTheDocument();
  expect(screen.getByText(/共 2 条笔记/)).toBeInTheDocument();
  expect(get).toHaveBeenCalledWith(summary.id);

  // Note cards also expose 删除 buttons, so deletion is scoped to the panel.
  await user.click(within(panel).getByRole('button', { name: '删除' }));
  // The same button now confirms the deletion.
  await user.click(within(panel).getByRole('button', { name: '确认删除' }));

  await waitFor(() => expect(remove).toHaveBeenCalledWith(summary.id));
  await waitFor(() => expect(list.mock.calls.length).toBeGreaterThanOrEqual(2));
});

it('discards a stale saved analysis when another is opened', async () => {
  const user = userEvent.setup();
  const other: NoteAnalysisSummaryDto = {
    ...summary,
    id: 'analysis-2',
    title: '三体人物',
    kind: 'viewpoints',
  };
  const first = deferred<NoteAnalysisDto>();
  const second = deferred<NoteAnalysisDto>();
  const list = vi.fn<NoteAnalysisApi['list']>(async () => [summary, other]);
  const get = vi
    .fn<NoteAnalysisApi['get']>()
    .mockReturnValueOnce(first.promise)
    .mockReturnValueOnce(second.promise);

  renderPage(makeApi({ list, get }));
  const panel = await openPanel(user);

  await user.click(within(panel).getByRole('button', { name: summary.title }));
  expect(screen.getByText('正在加载分析…')).toBeInTheDocument();

  await user.click(within(panel).getByRole('button', { name: other.title }));

  await act(async () => {
    second.resolve({ ...detail, id: other.id, title: other.title, content: '第二条分析' });
    first.resolve({ ...detail, content: '第一条分析' });
  });

  expect(screen.getByText('第二条分析')).toBeInTheDocument();
  expect(screen.queryByText('第一条分析')).not.toBeInTheDocument();
});

it('shows an open failure without replacing the history list', async () => {
  const user = userEvent.setup();
  const list = vi.fn<NoteAnalysisApi['list']>(async () => [summary]);
  const get = vi
    .fn<NoteAnalysisApi['get']>()
    .mockRejectedValueOnce(new ApiError(404, 'NOT_FOUND', 'missing'))
    .mockResolvedValue(detail);

  renderPage(makeApi({ list, get }));
  const panel = await openPanel(user);

  await user.click(within(panel).getByRole('button', { name: summary.title }));
  expect(await screen.findByText('找不到请求的内容')).toBeInTheDocument();
  expect(within(panel).getByRole('button', { name: summary.title })).toBeInTheDocument();

  await user.click(within(panel).getByRole('button', { name: summary.title }));
  expect(await screen.findByText('已保存的分析内容')).toBeInTheDocument();
  expect(screen.queryByText('找不到请求的内容')).not.toBeInTheDocument();
});

it('disables analysis while offline', async () => {
  const user = userEvent.setup();
  renderPage(makeApi());
  await openPanel(user);

  await act(async () => {
    Object.defineProperty(navigator, 'onLine', { configurable: true, value: false });
    window.dispatchEvent(new Event('offline'));
  });

  const start = screen.getByRole('button', { name: '开始分析' });
  await waitFor(() => expect(start).toBeDisabled());
  expect(screen.getByText('离线时无法使用 AI 分析')).toBeInTheDocument();
});

it('closes on Escape and restores focus to the trigger', async () => {
  const user = userEvent.setup();
  renderPage(makeApi());
  const trigger = screen.getByRole('button', { name: '分析笔记' });
  await openPanel(user);

  expect(screen.getByRole('heading', { name: 'AI 笔记分析' })).toHaveFocus();

  await user.keyboard('{Escape}');
  await waitFor(() =>
    expect(screen.queryByRole('complementary', { name: 'AI 笔记分析' })).not.toBeInTheDocument(),
  );
  expect(trigger).toHaveFocus();
});

// The panel is exported separately so tests can mount it without the page.
it('settles a transport that resolves without a terminal frame', async () => {
  const user = userEvent.setup();
  const api = makeApi();
  const { container } = renderWithProviders(
    <MemoryRouter>
      <NoteAnalysisPanel filters={{}} online api={api} onClose={() => undefined} />
    </MemoryRouter>,
  );

  await user.click(screen.getByRole('button', { name: '开始分析' }));
  await waitFor(() => expect(api.stream).toHaveBeenCalled());
  await waitFor(() =>
    expect(container.querySelector('[data-status="complete"]')).not.toBeNull(),
  );
});
